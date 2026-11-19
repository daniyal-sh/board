import fs from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { AgentEvent, AgentProviderId, ProjectKind } from "@studio/shared";
import { sendToAgent } from "./agents/manager";
import { buildExport, buildPreview, closeInspector, inspectPreview } from "./build/preview";
import { projects } from "./projects";

/**
 * Development self-test, run with STUDIO_SELFTEST=<out dir>:
 *   STUDIO_SELFTEST_MODE=build   build sample Lab + web animation, save screenshots (default)
 *   STUDIO_SELFTEST_MODE=agent   also run a real agent turn (STUDIO_SELFTEST_AGENT=claude|codex)
 * Prints a JSON report and quits.
 */
const SAMPLE_LAB = {
  "lab/index.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Parabola Lab</title></head>
<body><main class="lab">
  <h1 data-part="title">Parabola Lab</h1>
  <p class="lead" data-part="intro">Drag the slider and watch $y = a x^2$ change.</p>
  <section data-part="explore"><h2>Explore</h2>
  <div class="lab-row">
    <div id="board" class="lab-card" style="aspect-ratio:4/3;padding:0" data-part="board"></div>
    <div class="lab-stack">
      <lab-slider name="a" label="a" min="-3" max="3" step="0.1" value="1"></lab-slider>
      <div class="lab-card lab-readout" id="eq" data-part="equation"></div>
    </div>
  </div></section>
  <section data-part="check"><h2>Check yourself</h2>
  <lab-check question="What happens when a is negative?" choices="Opens up|Opens down|Flat" answer="Opens down" explain="A negative a flips the parabola."></lab-check>
  </section>
</main><script type="module" src="./main.ts"></script></body></html>`,
  "lab/main.ts": `import "@studio/lab-kit";
import { slider, watch } from "@studio/lab-kit";
import { renderMath, tex } from "@studio/lab-kit/math";
import JXG from "jsxgraph";
import "jsxgraph/distrib/jsxgraph.css";
renderMath();
const board = JXG.JSXGraph.initBoard("board", { boundingbox: [-5, 5, 5, -5], axis: true, showCopyright: false, showNavigation: false });
board.create("functiongraph", [(x: number) => slider("a").value * x * x], { strokeColor: "#58C4DD", strokeWidth: 3 });
watch(["a"], () => { document.querySelector("#eq")!.innerHTML = tex("y = " + slider("a").value.toFixed(1) + "x^2"); board.update(); });
`,
};

const SAMPLE_WEB = {
  "scenes/01_circle.ts": `import { Scene, Circle, Square, Create, Transform, BLUE, YELLOW } from "manim-web";
export const title = "Circle to square";
export default async function (scene: Scene) {
  const shape = new Circle({ radius: 1.5, color: BLUE });
  await scene.play(new Create(shape));
  await scene.play(new Transform(shape, new Square({ sideLength: 3, color: YELLOW })));
  await scene.wait(1);
}
`,
};

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(join(dir, rel, ".."), { recursive: true });
    fs.writeFileSync(join(dir, rel), content);
  }
}

async function buildCase(out: string, kind: ProjectKind, files: Record<string, string>, report: Record<string, unknown>) {
  const p = await projects.create({ kind, prompt: `Selftest ${kind}`, length: "short", title: `Selftest ${kind} ${Date.now()}` });
  writeFiles(p.dir, files);
  const res = await buildPreview(p.manifest.id);
  const entry: Record<string, unknown> = { projectId: p.manifest.id, dir: p.dir, ok: res.ok, errors: res.errors, size: res.sizeBytes, libraries: res.libraries };
  if (res.ok) {
    const exported = await buildExport(p.manifest.id);
    fs.writeFileSync(join(out, `${kind}.html`), exported.html);
    entry.exportSize = exported.sizeBytes;
    entry.scenes = projects.manifest(p.manifest.id).scenes;
    const viewports = kind === "lab" ? (["desktop", "phone"] as const) : (["desktop"] as const);
    for (const vp of viewports) {
      const r = await inspectPreview(p.manifest.id, { viewport: vp, times: kind === "web" ? [1, 3.5] : [1.5] });
      r.frames.forEach((f, i) => fs.writeFileSync(join(out, `${kind}-${vp}-${i}.png`), f.png));
      entry[`console_${vp}`] = r.console;
    }
  }
  report[kind] = entry;
}

async function agentCase(out: string, provider: AgentProviderId, report: Record<string, unknown>) {
  const prompt =
    process.env.STUDIO_SELFTEST_PROMPT ??
    "Make a small Lab for Grade 9: a slider for the number of sides of a regular polygon (3 to 12) and a canvas drawing it, with the interior angle sum shown. Keep it short.";
  const p = await projects.create({ kind: "lab", prompt, length: "short", provider });
  const events: AgentEvent[] = [];
  const done = new Promise<void>((resolve) => {
    void sendToAgent({ projectId: p.manifest.id, text: prompt }, (e) => {
      events.push(e);
      if (e.type === "step") console.log(`[step] ${e.status} ${e.label} ${e.detail ?? ""}`);
      if (e.type === "turn.completed" || e.type === "turn.failed") resolve();
    });
  });
  await done;
  const last = events.filter((e) => e.type === "turn.completed" || e.type === "turn.failed").pop();
  const res = await buildPreview(p.manifest.id);
  if (res.ok) {
    const r = await inspectPreview(p.manifest.id, { times: [1.5] });
    fs.writeFileSync(join(out, `agent-${provider}.png`), r.frames[0].png);
  }
  report[`agent_${provider}`] = {
    dir: p.dir,
    result: last,
    reply: events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("").slice(0, 1500),
    steps: events.filter((e) => e.type === "step" && e.status !== "running").map((e) => (e as { label: string; detail?: string }).label + " " + ((e as { detail?: string }).detail ?? "")),
    build: { ok: res.ok, errors: res.errors, libraries: res.libraries },
    scenes: projects.manifest(p.manifest.id).scenes,
  };
}

async function voiceCase(out: string, report: Record<string, unknown>) {
  const voice = await import("./voice");
  const p = await projects.create({ kind: "web", prompt: "Selftest voice", length: "short", title: `Selftest voice ${Date.now()}` });
  writeFiles(p.dir, {
    "scenes/01_circle.ts": `import { Scene, Circle, Square, Create, Transform, BLUE, YELLOW } from "manim-web";
export const title = "Circle to square";
export default async function (scene: Scene) {
  const shape = new Circle({ radius: 1.5, color: BLUE });
  await scene.play(new Create(shape));
  await (scene as any).waitUntil("square");
  await scene.play(new Transform(shape, new Square({ sideLength: 3, color: YELLOW })));
}
`,
    "narration/01_circle.md": "Here is a circle. It has no corners at all. Now watch it turn into a {{mark:square}} square, with four equal sides.",
  });
  const id = p.manifest.id;
  const t0 = Date.now();
  const ai = await voice.generateNarration(id, "01_circle", { voice: "af_heart", speed: 1 }, (m) => console.log("[voice]", m));
  const aiMs = Date.now() - t0;
  // Feed the AI audio back through the recording path to check Whisper alignment.
  const wav = fs.readFileSync(join(p.dir, "build", "narration", "01_circle.wav"));
  const pcm24 = new Float32Array((wav.length - 44) / 2).map((_, i) => wav.readInt16LE(44 + i * 2) / 32768);
  const pcm16 = new Float32Array(Math.floor(pcm24.length / 1.5)).map((_, i) => pcm24[Math.floor(i * 1.5)]);
  const rec = await voice.narrationFromRecording(id, "01_circle", pcm16, (m) => console.log("[asr]", m));
  // Restore the AI narration for the preview build.
  await voice.generateNarration(id, "01_circle", { voice: "af_heart", speed: 1 }, () => {});
  const res = await buildPreview(id);
  let consoleLines: unknown = null;
  if (res.ok) {
    const r = await inspectPreview(id, { times: [1, 5.5] });
    r.frames.forEach((f, i) => fs.writeFileSync(join(out, `voice-${i}.png`), f.png));
    consoleLines = r.console;
  }
  report.voice = { aiMs, aiDuration: ai.duration, aiMarks: ai.marks, aiCaptions: ai.captions, recordingMarks: rec.marks, recordingCaptions: rec.captions, build: res.ok, size: res.sizeBytes, console: consoleLines };
}

async function videoCase(out: string, report: Record<string, unknown>) {
  const { setupVideoEnv } = await import("./video/env");
  const { video } = await import("./video/renderer");
  const voice = await import("./voice");
  const t0 = Date.now();
  const env = await setupVideoEnv((step, m) => console.log(`[setup:${step}]`, m.slice(0, 160)));
  const setupMs = Date.now() - t0;
  const p = await projects.create({ kind: "video", prompt: "Selftest video", length: "short", title: `Selftest video ${Date.now()}` });
  writeFiles(p.dir, {
    "scenes/01_curve.py": `from manim import *
from studio_manim import StudioScene


class TheCurve(StudioScene):
    """The curve"""

    def construct(self):
        f = lambda x: 0.09 * (x - 1) * (x - 4) * (x - 7) + 2.4
        axes = Axes(x_range=[-1, 9, 1], y_range=[-1, 6, 1], x_length=10, y_length=6)
        graph = axes.plot(f, color=BLUE)
        title = MathTex(r"f(x) = 0.09(x-1)(x-4)(x-7) + 2.4").to_edge(UP)
        self.play(Create(axes), Create(graph))
        self.wait_until("secant")
        x0, h = 2.2, ValueTracker(2.6)
        secant_line = always_redraw(lambda: Line(axes.c2p(x0, f(x0)), axes.c2p(x0 + h.get_value(), f(x0 + h.get_value())), color=YELLOW))
        self.play(Create(secant_line), Write(title))
        self.play(h.animate.set_value(0.05), run_time=2)
        self.wait(0.5)
`,
    "scenes/02_end.py": `from manim import *
from studio_manim import StudioScene


class TheEnd(StudioScene):
    """Wrap up"""

    def construct(self):
        message = Text("That slope is the derivative.", font_size=40)
        self.play(Write(message))
        self.wait(0.5)
`,
    "narration/01_curve.md": "Here is a curve. Now join two points with a {{mark:secant}} secant line, and slide them together.",
  });
  const id = p.manifest.id;
  const r1 = await video.renderPreview(id, "01_curve");
  const tl = video.timeline(id, "01_curve");
  const frames = r1.ok ? await video.frames(id, "01_curve", [1, 3]) : [];
  frames.forEach((f, i) => fs.writeFileSync(join(out, `video-${i}.png`), f.png));
  let narr: unknown = null;
  let r2: unknown = null;
  try {
    narr = await voice.generateNarration(id, "01_curve", { voice: "am_michael", speed: 1 }, () => {});
    r2 = await video.renderPreview(id, "01_curve");
  } catch (e) {
    narr = String(e);
  }
  const tl2 = video.timeline(id, "01_curve");
  const r3 = await video.renderPreview(id, "02_end");
  report.video = {
    env,
    setupMinutes: (setupMs / 60000).toFixed(1),
    render1: { ok: r1.ok, seconds: r1.seconds, duration: r1.durationSec, log: r1.log.slice(-1500) },
    timelinePlays: tl?.plays.map((p) => `${p.kind} ${p.label} ${p.start}-${p.end} L${p.line}`),
    timelineParts: tl?.parts.map((p) => `${p.name}:${p.type}@L${p.line} boxes=${p.boxes.length}`),
    frames: frames.length,
    narration: narr,
    render2: r2,
    marksInTimeline: tl2?.marks,
    durationWithVoice: tl2?.duration,
    render3: { ok: r3.ok, log: r3.log.slice(-600) },
    scenes: projects.manifest(id).scenes,
  };
}

/** Publish a sample Lab to a running cloud (STUDIO_CLOUD_URL) with a pre-made session token. */
async function publishCase(report: Record<string, unknown>) {
  const cloud = await import("./publish");
  cloud.setTokenForTesting(process.env.STUDIO_SELFTEST_TOKEN ?? "testtoken");
  const me = await cloud.account();
  const p = await projects.create({ kind: "lab", prompt: "Selftest publish", length: "short", title: `Selftest publish ${Date.now()}` });
  writeFiles(p.dir, SAMPLE_LAB);
  const first = await cloud.publish({ projectId: p.manifest.id, visibility: "unlisted" });
  const page = await fetch(first.url).then((r) => r.text());
  const contentUrl = /<iframe src="([^"]+)"/.exec(page)?.[1]?.replaceAll("&amp;", "&");
  const content = contentUrl ? await fetch(contentUrl) : null;
  const html = content ? await content.text() : "";
  const again = await cloud.publish({ projectId: p.manifest.id, visibility: "unlisted" });
  const vis = await cloud.setVisibility(p.manifest.id, "private");
  const anon = await fetch(first.url).then((r) => r.status);
  await cloud.unpublish(p.manifest.id);
  const gone = await fetch(first.url).then((r) => r.status);
  report.publish = {
    me,
    url: first.url,
    sameIdOnUpdate: again.id === first.id,
    contentStatus: content?.status,
    contentCsp: content?.headers.get("content-security-policy")?.slice(0, 60),
    contentHasLab: html.includes("Parabola Lab") && !html.includes("__studioPreview"),
    contentBytes: html.length,
    privateVisibility: vis.visibility,
    anonymousAfterPrivate: anon,
    afterUnpublish: gone,
  };
}

/** Drive the real UI in an offscreen window and save screenshots of each screen. */
async function uiCase(out: string, report: Record<string, unknown>) {
  const { BrowserWindow } = await import("electron");
  const { paths } = await import("./paths");
  const win = new BrowserWindow({
    show: false,
    width: 1360,
    height: 880,
    webPreferences: { offscreen: true, preload: paths.preload, sandbox: true, contextIsolation: true },
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name: string) => fs.writeFileSync(join(out, `ui-${name}.png`), (await win.webContents.capturePage()).toPNG());
  const js = (code: string) => win.webContents.executeJavaScript(code);
  const clickText = (text: string) =>
    js(`(() => { const el = [...document.querySelectorAll("button")].find(b => b.textContent.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})); if (el) { el.click(); return true } return false })()`);
  const errors: string[] = [];
  win.webContents.on("console-message", (e) => {
    const ev = e as unknown as { level: string | number; message: string };
    if ((ev.level === "error" || ev.level === 3) && !/Electron Security/.test(ev.message)) errors.push(ev.message);
  });
  await win.loadFile(paths.rendererHtml);
  await wait(2500);
  await shot("home");
  const target = process.env.STUDIO_SELFTEST_UI_PROJECT ?? "Interior Angles";
  report.uiOpened = await clickText(target);
  await wait(5000);
  await shot("studio");
  report.uiSelect = await clickText("Select");
  await wait(400);
  await shot("select");
  await clickText("Share");
  await wait(800);
  await shot("share");
  await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  await clickText("Selftest voice");
  report.uiErrors = errors;
  win.destroy();
}

export async function runSelftest(out: string): Promise<void> {
  fs.mkdirSync(out, { recursive: true });
  const report: Record<string, unknown> = {};
  try {
    const mode = process.env.STUDIO_SELFTEST_MODE ?? "build";
    if (mode === "build" || mode === "all") {
      await buildCase(out, "lab", SAMPLE_LAB, report);
      await buildCase(out, "web", SAMPLE_WEB, report);
    }
    if (mode === "voice" || mode === "all") await voiceCase(out, report);
    if (mode === "video" || mode === "all") await videoCase(out, report);
    if (mode === "ui") await uiCase(out, report);
    if (mode === "publish") await publishCase(report);
    if (mode === "agent" || mode === "all") {
      await agentCase(out, (process.env.STUDIO_SELFTEST_AGENT as AgentProviderId) ?? "claude", report);
    }
  } catch (e) {
    report.fatal = e instanceof Error ? e.stack : String(e);
  }
  fs.writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log("SELFTEST_REPORT " + join(out, "report.json"));
  closeInspector();
  setTimeout(() => app.exit(0), 200);
}
