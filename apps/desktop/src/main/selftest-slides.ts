import fs from "node:fs";
import { join } from "node:path";
import type { SlidesEngine } from "@studio/shared";
import { buildDeckExport, buildDeckPreview, closeInspector, deckScript, deckSession, deckSteps, deckThumbnails } from "./build/preview";
import { projects } from "./projects";
import { videoEnvStatus } from "./video/env";

/**
 * Selftest for Slides (STUDIO_SELFTEST_MODE=slides): a deck per engine with an HTML title slide
 * that builds in steps, an animated slide with stops and an interactive JSXGraph slide. Checks the
 * step counts, walks forward and back, takes a picture of every step and exports the deck.
 */
const HTML_TITLE = `<!-- title: Slopes -->
<!-- class: title -->
<h1 data-part="title">Slopes and tangents</h1>
<h3 data-step="1" data-part="subtitle">Grade 11 · Calculus</h3>
<p data-step="2" class="muted">Three ideas, ten minutes.</p>
`;

const HTML_EXPLORE = `<!-- title: Try it -->
<!-- class: top -->
<h2 data-part="heading">Drag the point</h2>
<div class="columns wide-left fill">
  <div id="board" data-part="board" style="height:640px"></div>
  <div class="stack">
    <p data-part="readout">slope = <b id="slope">1.00</b></p>
    <p data-step="1" class="muted">The slope is the rise over the run.</p>
  </div>
</div>
<style>#board { border-radius: 20px; overflow: hidden; background: #15151b; }</style>
<script type="module">
  import JXG from "jsxgraph";
  import "jsxgraph/distrib/jsxgraph.css";
  import { thisSlide } from "@studio/lab-kit/deck";
  const slide = thisSlide();
  const board = JXG.JSXGraph.initBoard(slide.querySelector("#board"), { boundingbox: [-5, 5, 5, -5], axis: true, showCopyright: false, showNavigation: false });
  const p = board.create("point", [2, 2], { name: "P", size: 6 });
  board.create("line", [[0, 0], p], { strokeColor: "#FFE14D", strokeWidth: 3 });
  const show = () => { slide.querySelector("#slope").textContent = (p.Y() / (p.X() || 1e-9)).toFixed(2); };
  board.on("update", show);
  export function onEnter() { board.fullUpdate(); }
  export function onStep(step) { (window as any).__lastStep = step; }
</script>
`;

const WEB_SLIDE = `import { Axes, Create, Write, MathTex, BLUE, UP } from "manim-web";
import type { SlideScene } from "@studio/lab-kit/deck-web";
export const title = "The curve";
export default async function (scene: SlideScene) {
  const axes = new Axes({ xRange: [-1, 9, 1], yRange: [-1, 6, 1], xLength: 10, yLength: 5.5 });
  await scene.play(new Create(axes));
  await scene.nextSlide();
  const graph = axes.plot((x) => Math.sin(x) + 2, { color: BLUE });
  await scene.play(new Create(graph));
  await scene.nextSlide();
  await scene.play(new Write(new MathTex({ latex: "y = \\\\sin x + 2" }).toEdge(UP)));
}
`;

const PY_SLIDE = `from manim import *
from studio_manim import StudioScene


class TheCurve(StudioScene):
    """The curve"""

    def construct(self):
        axes = Axes(x_range=[-1, 9, 1], y_range=[-1, 6, 1], x_length=10, y_length=5.5)
        self.play(Create(axes))
        self.next_slide()
        graph = axes.plot(lambda x: np.sin(x) + 2, color=BLUE)
        self.play(Create(graph))
        self.next_slide()
        label = Text("y = sin x + 2", font_size=40).to_edge(UP)
        self.play(Write(label))
`;

async function deckCase(out: string, engine: SlidesEngine, report: Record<string, unknown>): Promise<void> {
  const p = await projects.create({ kind: "slides", engine, prompt: `Selftest slides ${engine}`, length: "short", title: `Selftest slides ${engine} ${Date.now()}` });
  const id = p.manifest.id;
  fs.rmSync(join(p.dir, "scenes", "01_title.html"), { force: true });
  fs.writeFileSync(join(p.dir, "scenes", "01_title.html"), HTML_TITLE);
  fs.writeFileSync(join(p.dir, "scenes", engine === "web" ? "02_curve.ts" : "02_curve.py"), engine === "web" ? WEB_SLIDE : PY_SLIDE);
  fs.writeFileSync(join(p.dir, "scenes", "03_explore.html"), HTML_EXPLORE);
  fs.mkdirSync(join(p.dir, "notes"), { recursive: true });
  fs.writeFileSync(join(p.dir, "notes", "02_curve.md"), "Ask: where is the curve steepest?");
  const entry: Record<string, unknown> = { dir: p.dir, scenes: projects.manifest(id).scenes.map((s) => `${s.id}:${s.slideType}:${s.title}`) };
  report[`slides_${engine}`] = entry;

  const t0 = Date.now();
  const built = await buildDeckPreview(id, (m) => console.log(`[deck] ${m}`));
  entry.build = { ok: built.ok, errors: built.errors, warnings: built.warnings, size: built.sizeBytes, libraries: built.libraries, ms: Date.now() - t0 };
  if (!built.ok) return;

  const steps = await deckSteps(id, {});
  entry.slides = steps.slides.map((s) => `${s.id} ${s.type} steps=${s.steps} notes=${s.notes ? "yes" : "no"}`);
  entry.findings = steps.frames.flatMap((f) => f.findings.map((x) => `${f.slide}#${f.step}: ${x}`));
  entry.layoutItems = steps.frames.map((f) => `${f.slide}#${f.step}: ${f.layout.length}`);
  entry.console = steps.console;
  for (const f of steps.frames) fs.writeFileSync(join(out, `slides-${engine}-${f.slide}-${f.step}.png`), f.png);

  // Walk the deck like a presenter: forward through everything, then back two steps.
  entry.navigation = await deckScript<string[]>(
    id,
    `async () => {
      const d = window.__studioDeck;
      const at = (s) => s.slide + ":" + s.step + (s.playing ? "+" : "");
      const log = [at(d.state())];
      for (let i = 0; i < 9; i++) log.push(at(await d.next()));
      log.push("back", at(await d.prev()), at(await d.prev()), at(await d.prev()), at(await d.prev()));
      return log;
    }`,
  );

  // Ink: draw a stroke with the pen on the canvas, then move on (ink belongs to its step).
  entry.ink = await deckScript<Record<string, unknown>>(
    id,
    `async () => {
      const d = window.__studioDeck;
      await d.goto("01_title", 0);
      d.ink.setTool("pen");
      const c = document.querySelector(".deck-ink");
      const r = c.getBoundingClientRect();
      const ev = (type, f) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: r.left + r.width * f, clientY: r.top + r.height * 0.5, buttons: type === "pointerup" ? 0 : 1 }));
      ev("pointerdown", 0.3); ev("pointermove", 0.4); ev("pointermove", 0.5); ev("pointerup", 0.5);
      const drawn = d.ink.hasInk();
      const toolAttr = c.dataset.tool;
      d.ink.setTool("pointer");
      await d.next();
      return { drawn, toolAttr, clearedOnNext: !d.ink.hasInk(), at: d.state().slide + ":" + d.state().step };
    }`,
  );

  const interact = await deckSession(id, { scene: "03_explore", actions: [{ wait: 200 }] });
  entry.interact = { controls: interact.controls, findings: interact.findings, console: interact.console };
  fs.writeFileSync(join(out, `slides-${engine}-interact.png`), interact.png);

  entry.thumbs = await deckThumbnails(id);
  entry.scenesAfter = projects.manifest(id).scenes.map((s) => `${s.id}:${s.thumbUrl ? "thumb" : "-"}`);

  const exported = await buildDeckExport(id, { mode: "inline" }, (m) => console.log(`[export] ${m}`));
  fs.writeFileSync(join(out, `slides-${engine}.html`), exported.html);
  entry.export = { size: exported.sizeBytes, libraries: exported.libraries };
  entry.exported = await openExported(join(out, `slides-${engine}.html`));
}

/** The exported file on its own: the deck with its tools, and the speaker view page. */
async function openExported(file: string): Promise<Record<string, unknown>> {
  const { BrowserWindow } = await import("electron");
  const { pathToFileURL } = await import("node:url");
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { offscreen: true, sandbox: true } });
  const errors: string[] = [];
  win.webContents.on("console-message", (e) => {
    const ev = e as unknown as { level: string | number; message: string };
    if (ev.level === "error" || ev.level === 3) errors.push(ev.message.slice(0, 200));
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const url = pathToFileURL(file).href;
  await win.loadURL(url);
  await wait(2500);
  const deckOk = await win.webContents.executeJavaScript(`({ ready: Boolean(window.__studioDeck?.ready), tools: document.querySelectorAll(".deck-tools [data-tool]").length, speakerButton: Boolean(document.querySelector('[data-act="speaker"]')) })`);
  // Press S: the speaker window opens and follows; its buttons drive the deck.
  let child: Electron.BrowserWindow | null = null;
  win.webContents.setWindowOpenHandler(() => ({ action: "allow", overrideBrowserWindowOptions: { show: false, webPreferences: { offscreen: true, sandbox: true } } }));
  win.webContents.on("did-create-window", (w) => (child = w));
  await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }))`);
  await wait(4000);
  const sync: Record<string, unknown> = { opened: Boolean(child) };
  if (child) {
    const c = child as Electron.BrowserWindow;
    const read = () => c.webContents.executeJavaScript(`document.querySelector(".sp-pos")?.textContent + " | " + (document.querySelector(".sp-notes")?.textContent ?? "")`);
    sync.start = await read();
    await win.webContents.executeJavaScript(`window.__studioDeck.goto("02_curve", 0)`);
    await wait(1200);
    sync.afterGoto = await read();
    await c.webContents.executeJavaScript(`document.querySelector('[data-act="next"]').click()`);
    await wait(2500);
    sync.deckAfterSpeakerNext = await win.webContents.executeJavaScript(`(() => { const s = window.__studioDeck.state(); return s.slide + ":" + s.step; })()`);
    sync.speakerAfterNext = await read();
    c.destroy();
  }
  await win.loadURL("about:blank");
  await win.loadURL(`${url}#speaker`);
  await wait(1500);
  const speaker = await win.webContents.executeJavaScript(`({ view: Boolean(document.querySelector(".sp")), frames: document.querySelectorAll(".sp iframe").length, notes: document.querySelector(".sp-notes")?.textContent?.slice(0, 80) })`);
  win.destroy();
  return { deck: deckOk, sync, speaker, errors };
}

export async function slidesCase(out: string, report: Record<string, unknown>): Promise<void> {
  await deckCase(out, "web", report);
  if (videoEnvStatus().ready) await deckCase(out, "video", report);
  else report.slides_video = "skipped: video tools not installed (run the video selftest first)";
  closeInspector();
}
