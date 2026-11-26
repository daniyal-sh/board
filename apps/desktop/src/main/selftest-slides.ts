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

  const interact = await deckSession(id, { scene: "03_explore", actions: [{ wait: 200 }] });
  entry.interact = { controls: interact.controls, findings: interact.findings, console: interact.console };
  fs.writeFileSync(join(out, `slides-${engine}-interact.png`), interact.png);

  entry.thumbs = await deckThumbnails(id);
  entry.scenesAfter = projects.manifest(id).scenes.map((s) => `${s.id}:${s.thumbUrl ? "thumb" : "-"}`);

  const exported = await buildDeckExport(id, { mode: "inline" }, (m) => console.log(`[export] ${m}`));
  fs.writeFileSync(join(out, `slides-${engine}.html`), exported.html);
  entry.export = { size: exported.sizeBytes, libraries: exported.libraries };
}

export async function slidesCase(out: string, report: Record<string, unknown>): Promise<void> {
  await deckCase(out, "web", report);
  if (videoEnvStatus().ready) await deckCase(out, "video", report);
  else report.slides_video = "skipped: video tools not installed (run the video selftest first)";
  closeInspector();
}
