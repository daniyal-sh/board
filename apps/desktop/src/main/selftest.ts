import fs from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { AgentEvent, AgentProviderId, ProjectKind } from "@studio/shared";
import { interruptAgent, sendToAgent } from "./agents/manager";
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
  "scenes/02_dots.ts": `import { Scene, Dot, FadeIn, GREEN } from "manim-web";
export const title = "Dots";
export default async function (scene: Scene) {
  const d = new Dot({ color: GREEN });
  await scene.play(new FadeIn(d));
  await scene.wait(0.5);
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
    if (kind === "web") {
      const { webSceneThumbnails } = await import("./build/preview");
      entry.thumbs = await webSceneThumbnails(p.manifest.id);
      const td = join(p.dir, "build", "thumbs");
      if (fs.existsSync(td)) for (const f of fs.readdirSync(td)) fs.copyFileSync(join(td, f), join(out, `thumb-${f}`));
      entry.scenesAfter = projects.manifest(p.manifest.id).scenes;
    }
  }
  report[kind] = entry;
}

async function agentCase(out: string, provider: AgentProviderId, report: Record<string, unknown>) {
  const prompt =
    process.env.STUDIO_SELFTEST_PROMPT ??
    "Make a small Lab for Grade 9: a slider for the number of sides of a regular polygon (3 to 12) and a canvas drawing it, with the interior angle sum shown. Keep it short.";
  const settings = process.env.STUDIO_SELFTEST_AGENT_SETTINGS ? JSON.parse(process.env.STUDIO_SELFTEST_AGENT_SETTINGS) : { provider };
  const p = await projects.create({ kind: "lab", prompt, length: "short", agent: { ...settings, provider } });
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
  // Takes: a second take with a tapped cue, cut / undo / patch / retime, then back to take 1.
  const quiet = () => {};
  const take2 = await voice.narrationFromRecording(id, "01_circle", pcm16, quiet, { square: 5.2 });
  const takesAfter2 = voice.listTakes(id, "01_circle").map((t) => ({ id: t.id, active: t.active, duration: t.duration }));
  const firstWordEnd = take2.words?.find((w) => /circle/i.test(w.w))?.e ?? 1.2;
  const cut = await voice.editTake(id, "01_circle", { type: "cut", start: 0, end: firstWordEnd + 0.05 }, quiet);
  const canUndo = voice.listTakes(id, "01_circle").find((t) => t.active)?.canUndo;
  const undone = voice.undoTakeEdit(id, "01_circle");
  const patch = pcm16.slice(Math.floor(2.1 * 16000), Math.floor(3.6 * 16000));
  const replaced = await voice.editTake(id, "01_circle", { type: "replace", start: 0.1, end: firstWordEnd, pcm16k: patch }, quiet);
  const retimed = await voice.editTake(id, "01_circle", { type: "marks", marks: { square: 4.4 } }, quiet);
  const peaks = voice.narrationPeaks(id, "01_circle", 200);
  const back = voice.useTake(id, "01_circle", voice.listTakes(id, "01_circle")[0].id);
  report.takes = {
    take2Marks: take2.marks,
    takesAfter2,
    firstWordEnd,
    cut: { duration: cut.duration, marks: cut.marks, firstWords: cut.words?.slice(0, 4).map((w) => w.w).join(" "), canUndo },
    undone: undone && { duration: undone.duration, marks: undone.marks },
    replaced: { duration: replaced.duration, marks: replaced.marks, firstWords: replaced.words?.slice(0, 6).map((w) => w.w).join(" ") },
    retimed: retimed.marks,
    peaks: peaks && { n: peaks.length, max: Math.max(...peaks) },
    back: { take: back.take, marks: back.marks, duration: back.duration },
  };
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
  const shot = async (name: string) => {
    // Offscreen capture sometimes fails while a video is decoding; try again shortly after.
    for (let i = 0; ; i++) {
      try {
        fs.writeFileSync(join(out, `ui-${name}.png`), (await win.webContents.capturePage()).toPNG());
        return;
      } catch (e) {
        if (i >= 4) throw e;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  };
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
  if (!report.uiOpened) {
    // Not among the recent ones on Home: open it from the Projects page.
    await clickText("All projects");
    await wait(1200);
    report.uiOpened = await clickText(target);
  }
  await wait(5000);
  await shot("studio");
  // Scripted steps: [{"click":"text"},{"css":"selector"},{"wait":ms},{"shot":"name"},{"js":"code"}]
  for (const step of JSON.parse(process.env.STUDIO_SELFTEST_UI_STEPS ?? "[]") as Record<string, string | number>[]) {
    if (step.click) report[`click:${step.click}`] = await clickText(String(step.click));
    if (step.css) report[`css:${step.css}`] = await js(`(() => { const el = document.querySelector(${JSON.stringify(step.css)}); if (el) { el.click(); return true } return false })()`);
    if (step.js) await js(String(step.js));
    if (step.wait) await wait(Number(step.wait));
    if (step.view) {
      // What the assistant's get_view tool would return for the open project.
      const { setMainWindow } = await import("./window");
      const { teacherView } = await import("./agents/tools");
      setMainWindow(win);
      const id = projects.list().find((p) => p.title.includes(target))?.id ?? "";
      const v = await teacherView(id, undefined);
      if (v.png) fs.writeFileSync(join(out, `ui-${step.view}.png`), v.png);
      report[`view:${step.view}`] = v.text;
    }
    if (step.shot) await shot(String(step.shot));
  }
  if (process.env.STUDIO_SELFTEST_UI_CLICK) {
    report.uiClick = await clickText(process.env.STUDIO_SELFTEST_UI_CLICK);
    await wait(Number(process.env.STUDIO_SELFTEST_UI_WAIT ?? 8000));
    await js(`(() => { const v = document.querySelector("video"); if (v) v.currentTime = Number(${JSON.stringify(process.env.STUDIO_SELFTEST_UI_SEEK ?? "9.5")}); })()`);
    await wait(1500);
    await shot("click");
  }
  await js(`document.querySelector('button[title^="Choose the assistant"]')?.click()`);
  await wait(4000);
  await shot("picker");
  await js(`document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`);
  report.uiSelect = await clickText("Select");
  await wait(400);
  await shot("select");
  await clickText("Export");
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
    if (mode === "models") {
      const { providerModels } = await import("./agents/models");
      for (const prov of ["claude", "codex"] as const) {
        const t = Date.now();
        const r = await providerModels(prov, true);
        report[`models_${prov}`] = { ms: Date.now() - t, count: r.models.length, error: r.error, sample: r.models.slice(0, 4) };
      }
    }
    if (mode === "formats") await formatsCase(out, report);
    if (mode === "inspect") await inspectCase(out, report);
    if (mode === "demo") await demoCase(report);
    if (mode === "guided") {
      // A guided first message: the assistant should ask through the question card, then build.
      const { answerQuestions } = await import("./agents/approvals");
      const provider = (process.env.STUDIO_SELFTEST_AGENT ?? "claude") as AgentProviderId;
      const cheap = provider === "claude" ? { model: "haiku", effort: "low" } : { model: "gpt-5.6-luna", effort: "low" };
      const script = process.env.STUDIO_SELFTEST_SCRIPT === "1";
      const kind: ProjectKind = script ? "web" : "lab";
      const text = script
        ? "A circle is the set of points at the same distance from a centre. {{mark:radius}} That distance is the radius. Double it and you get the diameter."
        : "A small lab about the Pythagorean theorem";
      const p = await projects.create({ kind, prompt: text, length: "short", agent: { provider, ...cheap } });
      const id = p.manifest.id;
      const asked: unknown[] = [];
      const steps: string[] = [];
      let reply = "";
      const result = await new Promise<string>((resolve) => {
        void sendToAgent({ projectId: id, text, intro: { guided: true, script } }, (e) => {
          if (e.type === "question") {
            asked.push(e.request);
            setTimeout(() => answerQuestions(e.request.requestId, e.request.questions.map((q) => q.options[0]), () => {}), 300);
          }
          if (e.type === "step") steps.push(`${e.status} ${e.label}`);
          if (e.type === "text") reply += e.delta;
          if (e.type === "turn.completed" || e.type === "turn.failed") resolve(e.type === "turn.failed" ? `failed: ${e.error}` : "completed");
        });
      });
      const narr = join(p.dir, "narration");
      report[`guided_${provider}${script ? "_script" : ""}`] = {
        result,
        asked,
        steps: steps.filter((x) => x.startsWith("done")).length,
        scenes: projects.manifest(id).scenes.map((x) => x.id),
        narration: fs.existsSync(narr) ? fs.readdirSync(narr).filter((f) => f.endsWith(".md")).map((f) => [f, fs.readFileSync(join(narr, f), "utf8").slice(0, 200)]) : [],
        reply: reply.slice(-300),
      };
    }
    if (mode === "access") {
      // Approval cards answered automatically: allow, then deny; then Auto mode (no cards).
      const { respond } = await import("./agents/approvals");
      const provider = (process.env.STUDIO_SELFTEST_AGENT ?? "claude") as AgentProviderId;
      const cheap = provider === "claude" ? { model: "haiku", effort: "low" } : { model: "gpt-5.6-luna", effort: "low" };
      const p = await projects.create({ kind: "lab", prompt: "access", length: "short", title: `Access ${provider} ${Date.now()}`, agent: { provider, ...cheap, access: "ask" } });
      const id = p.manifest.id;
      const cmd = provider === "claude" ? 'node -e "console.log(6*7)"' : 'curl.exe -s -o NUL -w "%{http_code}" https://example.com';
      const ask =
        provider === "claude"
          ? `Run exactly this shell command and tell me its output in one line: ${cmd}`
          : "Download https://example.com into a file called example.html in this project folder, then tell me its size in bytes in one line.";
      const turn = (answer: "allow" | "deny" | null) =>
        new Promise<Record<string, unknown>>((resolve) => {
          const cards: string[] = [];
          let reply = "";
          void sendToAgent({ projectId: id, text: ask }, (e) => {
            if (e.type === "approval") {
              cards.push(`${e.request.kind}: ${e.request.title} | ${e.request.detail ?? ""}`);
              if (answer) setTimeout(() => respond(e.request.requestId, answer, () => {}), 300);
            }
            if (e.type === "text") reply += e.delta;
            if (e.type === "turn.completed" || e.type === "turn.failed") resolve({ result: e.type, cards, reply: reply.slice(-300) });
          });
        });
      const r: Record<string, unknown> = {};
      r.askAllow = await turn("allow");
      r.askDeny = await turn("deny");
      projects.saveManifest({ ...projects.manifest(id), agent: { provider, ...cheap, access: "auto" } });
      r.auto = await turn(null);
      report[`access_${provider}`] = r;
    }
    if (mode === "edges") {
      const provider = (process.env.STUDIO_SELFTEST_AGENT ?? "claude") as AgentProviderId;
      const cheap = provider === "claude" ? { model: "haiku", effort: "low" } : { model: "gpt-5.6-luna", effort: "low" };
      const p = await projects.create({ kind: "lab", prompt: "edge cases", length: "short", title: `Edges ${provider} ${Date.now()}`, agent: { provider, ...cheap } });
      const id = p.manifest.id;
      const turn = (text: string, abortAfterMs?: number) =>
        new Promise<{ ms: number; result: string; notices: string[]; steps: number }>((resolve) => {
          const t0 = Date.now();
          const notices: string[] = [];
          let steps = 0;
          void sendToAgent({ projectId: id, text }, (e) => {
            if (e.type === "notice") notices.push(e.text);
            if (e.type === "step" && e.status === "running") steps++;
            if (e.type === "turn.completed") resolve({ ms: Date.now() - t0, result: "completed", notices, steps });
            if (e.type === "turn.failed") resolve({ ms: Date.now() - t0, result: `failed: ${e.error}`, notices, steps });
          }).then(() => {
            if (abortAfterMs) setTimeout(() => interruptAgent(id), abortAfterMs);
          }, (err) => resolve({ ms: Date.now() - t0, result: `threw: ${err}`, notices, steps }));
        });
      const quick = "Reply with just the word OK. Do not use any tools.";
      const r: Record<string, unknown> = {};
      r.plain = await turn(quick);
      // Stale session / thread id
      projects.saveSession(id, { [provider]: provider === "claude" ? "00000000-0000-4000-8000-000000000000" : "019a0000-0000-7000-8000-000000000000" });
      r.staleSession = await turn(quick);
      // Bad model
      const m = projects.manifest(id);
      projects.saveManifest({ ...m, agent: { ...m.agent, model: provider === "claude" ? "claude-nonexistent-9" : "gpt-nonexistent-9" } });
      r.badModel = await turn(quick);
      projects.saveManifest({ ...projects.manifest(id), agent: { provider, ...cheap } });
      // Stop mid-turn, then make sure the harness still works
      r.stop = await turn("Build a Lab with a slider for the number of sides of a regular polygon and draw it on a canvas. Check your work with the Studio tools.", 9000);
      r.afterStop = await turn(quick);
      report[`edges_${provider}`] = r;
    }
    if (mode === "autonarrate") {
      const target = projects.list().find((x) => x.kind === "video" && /selftest video/i.test(x.title));
      if (!target) throw new Error("No selftest video project");
      const voice = await import("./voice");
      for (const s of projects.manifest(target.id).scenes) voice.removeNarration(target.id, s.id);
      const t = Date.now();
      const progress: string[] = [];
      const { autoNarrate } = await import("./narrate");
      const r = await autoNarrate(target.id, { voice: "af_heart", speed: 1 }, (e) => e.type === "step" && e.status === "done" && console.log("[step]", e.label, e.detail ?? ""), (m) => progress.push(m));
      const { video } = await import("./video/renderer");
      report.autonarrate = {
        minutes: ((Date.now() - t) / 60000).toFixed(1),
        result: r,
        progress: progress.filter((m) => !/Downloading/.test(m)).slice(-8),
        scripts: Object.fromEntries(projects.manifest(target.id).scenes.map((s) => [s.id, voice.readScript(target.id, s.id)])),
        marks: Object.fromEntries(projects.manifest(target.id).scenes.map((s) => [s.id, video.timeline(target.id, s.id)?.marks])),
        durations: Object.fromEntries(projects.manifest(target.id).scenes.map((s) => [s.id, video.timeline(target.id, s.id)?.duration])),
      };
    }
    if (mode === "full") {
      const { video } = await import("./video/renderer");
      const target = projects.list().find((x) => x.kind === "video" && /selftest video/i.test(x.title));
      if (!target) throw new Error("No selftest video project; run STUDIO_SELFTEST_MODE=video first");
      const run = async (label: string) => {
        const msgs: string[] = [];
        const t = Date.now();
        const r = await video.fullPreview(target.id, (m) => msgs.push(m));
        report[label] = { ms: Date.now() - t, ok: r.ok, duration: r.duration, segments: r.segments, failed: r.failed, progress: msgs };
      };
      await run("full_first");
      await run("full_cached");
      // Edit one scene: only it should re-render.
      const f = join(target.dir, "scenes", "02_end.py");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("That slope is the derivative.", "And that slope is the derivative!"));
      await run("full_after_edit");
      const frames = await video.frames(target.id, undefined, []);
      void frames;
    }
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

/** Vertical web animation and video, each exported as a GIF. */
async function formatsCase(out: string, report: Record<string, unknown>) {
  const { webGif, webSceneThumbnails } = await import("./build/preview");
  const { exportVideoGif } = await import("./video/export");
  const { setupVideoEnv } = await import("./video/env");
  const { video } = await import("./video/renderer");

  const w = await projects.create({ kind: "web", prompt: "formats", length: "short", aspect: "vertical", title: `Vertical web ${Date.now()}` });
  writeFiles(w.dir, SAMPLE_WEB);
  const wid = w.manifest.id;
  const built = await buildPreview(wid);
  const t0 = Date.now();
  let webErr: string | undefined;
  try {
    await webGif(wid, join(out, "web-vertical.gif"), { width: 360, height: 640, fps: 15 });
  } catch (e) {
    webErr = String(e);
  }
  report.webVertical = {
    build: built.ok,
    aspect: projects.manifest(wid).aspect,
    gifMs: Date.now() - t0,
    gifBytes: fs.existsSync(join(out, "web-vertical.gif")) ? fs.statSync(join(out, "web-vertical.gif")).size : 0,
    error: webErr,
    thumbs: await webSceneThumbnails(wid),
  };
  const td = join(w.dir, "build", "thumbs");
  if (fs.existsSync(td)) for (const f of fs.readdirSync(td)) fs.copyFileSync(join(td, f), join(out, `vthumb-${f}`));

  await setupVideoEnv(() => {});
  const v = await projects.create({ kind: "video", prompt: "formats", length: "short", aspect: "vertical", title: `Vertical video ${Date.now()}` });
  writeFiles(v.dir, {
    "scenes/01_tall.py": `from manim import *
from studio_manim import StudioScene


class Tall(StudioScene):
    def construct(self):
        title = Text("Tall", font_size=72).to_edge(UP)
        dots = VGroup(*[Dot(radius=0.2, color=BLUE) for _ in range(5)]).arrange(DOWN, buff=0.5)
        self.play(Write(title))
        self.play(LaggedStart(*[GrowFromCenter(d) for d in dots], lag_ratio=0.2))
        self.wait(0.5)
`,
  });
  const vid = v.manifest.id;
  const draft = await video.renderPreview(vid, "01_tall");
  const frames = await video.frames(vid, "01_tall", [1.5]);
  if (frames[0]) fs.writeFileSync(join(out, "video-vertical.png"), frames[0].png);
  const t1 = Date.now();
  let vidErr: string | undefined;
  try {
    await exportVideoGif(vid, join(out, "video-vertical.gif"), 360);
  } catch (e) {
    vidErr = String(e);
  }
  report.videoVertical = {
    draft: draft.ok,
    log: draft.ok ? undefined : draft.log,
    gifMs: Date.now() - t1,
    gifBytes: fs.existsSync(join(out, "video-vertical.gif")) ? fs.statSync(join(out, "video-vertical.gif")).size : 0,
    error: vidErr,
  };
}

/**
 * The assistant's inspection tools without an assistant: layout checks, keyframe sheets, Lab
 * interaction and the teacher's-view capture, on samples with deliberate problems.
 */
async function inspectCase(out: string, report: Record<string, unknown>) {
  const { webSteps, labSession } = await import("./build/preview");
  const { analyseLayout, snapshotsFromTimeline } = await import("./inspect/layout");
  const { contactSheet } = await import("./inspect/sheet");
  const { video } = await import("./video/renderer");
  const { videoEnvStatus } = await import("./video/env");

  // Web animation: a label that sits on top of another, and one pushed off the right edge.
  const w = await projects.create({ kind: "web", prompt: "inspect", length: "short", title: `Inspect web ${Date.now()}` });
  writeFiles(w.dir, {
    "scenes/01_clash.ts": `import { Scene, Circle, Text, Create, FadeIn, BLUE } from "manim-web";
export const title = "Clash";
export default async function (scene: Scene) {
  const c = new Circle({ radius: 1.5, color: BLUE });
  await scene.play(new Create(c));
  const a = new Text({ text: "Radius", fontSize: 48 });
  const b = new Text({ text: "Radius again", fontSize: 48 }).shift([0.4, 0.1, 0]);
  await scene.play(new FadeIn(a), new FadeIn(b));
  const edge = new Text({ text: "Off the edge", fontSize: 48 }).shift([7, 0, 0]);
  await scene.play(new FadeIn(edge));
}
`,
  });
  await buildPreview(w.manifest.id);
  const ws = await webSteps(w.manifest.id);
  report.webSteps = ws.frames.map((f) => ({ t: f.t, label: f.label, items: f.layout.map((i) => i.name) }));
  report.webFindings = analyseLayout(ws.frames.map((f) => ({ t: f.t, items: f.layout })), { frameHeightPx: 1080 });
  if (ws.frames.length) fs.writeFileSync(join(out, "web-sheet.png"), await contactSheet(ws.frames.map((f) => ({ png: f.png, label: `${f.t.toFixed(1)} s · ${f.label}` }))));
  report.webConsole = ws.console;

  // Lab: a slider that updates a readout, a button, and an over-wide element on phones.
  const l = await projects.create({ kind: "lab", prompt: "inspect", length: "short", title: `Inspect lab ${Date.now()}` });
  writeFiles(l.dir, {
    "lab/index.html": `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<main class="lab"><h1 data-part="title">Angle lab</h1>
<label for="angle">Angle</label><input id="angle" data-part="angle" type="range" min="0" max="90" value="30">
<p data-part="readout">Angle: <b id="out">30</b>°</p>
<button data-part="reset" id="reset">Reset</button>
<div style="width:700px;height:20px;background:#ddd" data-part="wide"></div>
</main><script type="module" src="./main.ts"></script></body></html>`,
    "lab/main.ts": `import "@studio/lab-kit";
const a = document.getElementById("angle") as HTMLInputElement;
const o = document.getElementById("out")!;
a.addEventListener("input", () => (o.textContent = a.value));
document.getElementById("reset")!.addEventListener("click", () => { a.value = "0"; o.textContent = "0"; });
`,
    "lab/style.css": "",
  });
  await buildPreview(l.manifest.id);
  const s1 = await labSession(l.manifest.id, { viewport: "phone", actions: [{ set: "angle", value: 75 }] });
  const readout1 = s1.controls;
  const s2 = await labSession(l.manifest.id, { viewport: "desktop", actions: [{ set: "Angle", value: 60 }, { click: "Reset" }, { click: "nonexistent" }] });
  fs.writeFileSync(join(out, "lab-phone.png"), s1.png);
  fs.writeFileSync(join(out, "lab-desktop.png"), s2.png);
  report.lab = { phoneResults: s1.results, phoneFindings: s1.findings, controls: readout1, desktopResults: s2.results, desktopFindings: s2.findings, console: s2.console };

  // Video: two labels on top of each other and one past the bottom edge.
  if (videoEnvStatus().ready) {
    const v = await projects.create({ kind: "video", prompt: "inspect", length: "short", title: `Inspect video ${Date.now()}` });
    writeFiles(v.dir, {
      "scenes/01_clash.py": `from manim import *
from studio_manim import StudioScene


class Clash(StudioScene):
    def construct(self):
        title = Text("Overlap test", font_size=48)
        label = Text("Overlap", font_size=48).shift(RIGHT * 0.3)
        self.play(Write(title))
        self.play(FadeIn(label))
        low = Text("Too low", font_size=40).shift(DOWN * 3.9)
        tiny = Text("tiny note", font_size=10).to_corner(UL)
        self.play(FadeIn(low), FadeIn(tiny))
        self.play(FadeOut(label))
        self.wait(0.5)
`,
    });
    const r = await video.renderPreview(v.manifest.id, "01_clash");
    const tl = video.timeline(v.manifest.id, "01_clash");
    report.videoFindings = r.ok && tl ? analyseLayout(snapshotsFromTimeline(tl), { frameHeightPx: 1080 }) : { error: r.log };
    if (tl) {
      const steps = tl.plays.filter((p) => p.kind !== "wait").map((p) => ({ t: Math.max(p.start + 0.01, p.end - 0.04), label: p.label, line: p.line }));
      const frames = await video.frames(v.manifest.id, "01_clash", steps.map((s) => s.t));
      fs.writeFileSync(join(out, "video-sheet.png"), await contactSheet(frames.map((f, i) => ({ png: f.png, label: `${steps[i].t.toFixed(1)} s · ${steps[i].label} · line ${steps[i].line}` }))));
    }
  }
}

/**
 * Showcase projects for the README, made the real way: the assistant builds each one from a
 * teacher-style prompt, then (videos and web animations) writes and voices the narration.
 * STUDIO_SELFTEST_DEMO picks which: "web", "video", "lab" (comma-separated; default all).
 */
async function demoCase(report: Record<string, unknown>) {
  const { autoNarrate } = await import("./narrate");
  const { agentDefaults } = await import("./agents/models");
  const { VOICES } = await import("./voice");
  const which = (process.env.STUDIO_SELFTEST_DEMO ?? "web,video,lab").split(",");
  const demos: { key: string; kind: ProjectKind; aspect?: "vertical"; title: string; prompt: string; length: "short" | "explainer" }[] = [
    {
      key: "web",
      kind: "web",
      title: "Why the derivative of sine is cosine",
      length: "explainer",
      prompt:
        "For a Year 12 class meeting calculus of trig functions: show why the derivative of sin x is cos x. Start with a point moving round the unit circle and its height tracing sin x, then show the slope of sin x at several points and plot those slopes, which trace out cos x. End with d/dx sin x = cos x. About 4 scenes, clean and uncluttered.",
    },
    {
      key: "video",
      kind: "video",
      aspect: "vertical",
      title: "Pythagoras in 30 seconds",
      length: "short",
      prompt:
        "A vertical 30-second reel proving the Pythagorean theorem by rearrangement: four copies of a right triangle inside a big square, first leaving a tilted square of area c², then rearranged to leave two squares a² and b². End on a² + b² = c². Bold and simple for phones, 3 scenes.",
    },
    {
      key: "lab",
      kind: "lab",
      title: "Projectile motion lab",
      length: "explainer",
      prompt:
        "A projectile motion lab for Year 10: sliders for launch angle and speed, a live trajectory on a canvas with the ground and a target, readouts for range, maximum height and flight time, and a 'predict, then launch' challenge where students guess the angle that hits the target. Clean, friendly, works on phones.",
    },
  ];
  for (const d of demos.filter((x) => which.includes(x.key))) {
    const p = await projects.create({ kind: d.kind, prompt: d.prompt, length: d.length, title: d.title, aspect: d.aspect, agent: agentDefaults() });
    const id = p.manifest.id;
    const t0 = Date.now();
    const done = await new Promise<string>((resolve) => {
      void sendToAgent({ projectId: id, text: d.prompt }, (e) => {
        if (e.type === "step" && e.status === "running") console.log(`[${d.key}] ${e.label} ${e.detail ?? ""}`);
        if (e.type === "turn.completed") resolve("completed");
        if (e.type === "turn.failed") resolve(`failed: ${e.error}`);
      });
    });
    const entry: Record<string, unknown> = { id, dir: p.dir, build: done, minutes: +((Date.now() - t0) / 60000).toFixed(1) };
    if (done === "completed" && d.kind !== "lab") {
      try {
        const r = await autoNarrate(id, { voice: VOICES[0].id, speed: 1 }, (e) => e.type === "step" && e.status === "running" && console.log(`[${d.key}:voice] ${e.label}`), (m) => console.log(`[${d.key}:voice] ${m}`));
        entry.narration = r;
      } catch (e) {
        entry.narration = String(e);
      }
    }
    entry.scenes = projects.manifest(id).scenes.map((s) => s.id);
    report[`demo_${d.key}`] = entry;
  }
}
