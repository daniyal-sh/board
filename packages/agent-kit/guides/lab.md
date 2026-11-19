# Building a Lab

A Lab is an interactive web page a teacher shares with students. It is not a video: students poke at it, change values, predict, and check themselves. The teacher steers what it should be. Do not force a format; pick what fits the idea and the teacher's request.

## Files

```
lab/index.html   page markup. Keep the <script type="module" src="./main.ts"></script> tag; the builder replaces it.
lab/main.ts      entry point (TypeScript or plain JS). Import libraries and lab/style.css here.
lab/style.css    page-specific styles (optional)
lab/assets/      images or data files you import from main.ts (they get inlined)
```

The builder bundles everything into **one self-contained HTML file** with no network access. So:

- Import libraries by name (`import JXG from "jsxgraph"`). Never use CDN URLs, `fetch()` to the internet, or web fonts from Google.
- Only the libraries listed below are available. Do not `npm install` anything.
- Keep the page light: prefer one main library. Three.js and manim-web are large (1–3 MB); use them only when 3D or Manim-style animation is the point.

## Available libraries

| Import | Use it for | Guide |
|---|---|---|
| `@studio/lab-kit` | sliders, step-through, checks, reveal, canvas helpers. Always available. | below |
| `@studio/lab-kit/math` | math typesetting (KaTeX): `$...$` in HTML, `tex()` in code | libs/katex.md |
| `jsxgraph` | interactive geometry and function graphs, draggable points, built-in sliders | libs/jsxgraph.md |
| `d3` | custom data visualisation, scales, axes, transitions | libs/d3.md |
| `@observablehq/plot` | quick statistical charts (histograms, scatter, line) | libs/plot.md |
| `matter-js` | 2D physics: collisions, ramps, pendulums, springs | libs/matter.md |
| `gsap` | timeline animations of SVG/HTML, step-by-step explanations | libs/gsap.md |
| `three` | 3D: solids, vectors, surfaces, molecules | libs/three.md |
| `manim-web` | Manim-style animated math scenes (TypeScript port of Manim) | libs/manim-web.md |

Plain Canvas 2D and inline SVG need no library and are often the best choice.

## Lab kit

```ts
import "@studio/lab-kit";                       // styles + custom elements
import { slider, watch, hidpi, loop, color } from "@studio/lab-kit";
```

```html
<main class="lab">
  <h1>Projectile Motion Lab</h1>
  <p class="lead">Change the angle and speed. Where does the ball land?</p>
  <div class="lab-row">
    <div class="lab-stage"><canvas id="sim" data-part="trajectory"></canvas></div>
    <div class="lab-stack">
      <lab-slider name="angle" label="Angle θ" min="5" max="85" value="45" unit="°"></lab-slider>
      <lab-slider name="speed" label="Speed v" min="5" max="30" value="20" unit=" m/s"></lab-slider>
      <div class="lab-card lab-readout" id="range" data-part="range_readout"></div>
    </div>
  </div>
  <lab-reveal label="Predict first, then reveal">
    <div slot="hidden">The range is largest at 45° because $\sin 2\theta$ peaks there.</div>
  </lab-reveal>
  <lab-check question="Which angle goes farthest?" choices="30°|45°|60°" answer="45°"
             explain="sin 2θ is largest when 2θ = 90°."></lab-check>
  <lab-steps>
    <lab-step><h2>1. Launch</h2>…</lab-step>
    <lab-step><h2>2. Measure</h2>…</lab-step>
  </lab-steps>
</main>
```

```ts
const ctx = hidpi(document.querySelector("#sim")!, 720, 405);
watch(["angle", "speed"], () => draw(slider("angle").value, slider("speed").value));
```

Classes: `.lab` (page container), `.lab-row` (main + side column, stacks on phones), `.lab-stack`, `.lab-card`, `.lab-stage` (dark canvas frame), `.lab-btn` / `.lab-btn.primary`, `.lab-readout`, `.lead`, `.lab-note`.
CSS variables: `--lab-ink`, `--lab-accent`, `--lab-good`, `--lab-bad`, `--manim-blue`, `--manim-yellow`, `--manim-red`, `--manim-green`, `--manim-purple`. The page follows the student's light/dark setting.

## Rules that make Labs good

1. **Name the parts.** Put `data-part="snake_case_name"` on every meaningful element (canvases, panels, readouts, buttons). Teachers click parts in the preview to ask for changes, and you receive that name. Lab kit elements get one from their `name` automatically.
2. **Works on a phone.** Use `.lab-row` or CSS grid that stacks under 720px. Canvases scale to their container width. Touch works (pointer events, not mouse events).
3. **Accessible.** Real `<button>`s, labels on inputs, enough contrast, no information carried by colour alone. Respect `prefers-reduced-motion`.
4. **Explain on the page.** Short instructions above the interactive part. Use the teacher's level and language.
5. **Correct.** Get the science and maths right. Show units. Label axes.
6. **Self-check.** After building, call `render_preview`, then `get_console` (fix every error), then `get_frames` to look at desktop and phone layouts. Fix anything cramped, overlapping or blank.

## Patterns you can offer (not required)

- Explore: sliders → live picture → readout.
- Predict, then reveal: ask first (`<lab-reveal>`), then show.
- Guided steps (`<lab-steps>`): one idea per step.
- Check yourself (`<lab-check>`): instant feedback, with an explanation.
- Challenge: a target the student has to hit ("land the ball in the bucket").
