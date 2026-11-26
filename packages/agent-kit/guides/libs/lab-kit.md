# Lab kit (`@studio/lab-kit`)

Ready-made pieces for the classic Lab: labelled sliders, step-through, multiple-choice checks, predict-then-reveal, and a calm house style (cards, readouts, a dark canvas stage). Use it when those are what the idea needs; skip it when you are designing a different kind of page.

Importing `@studio/lab-kit` also applies its stylesheet to the whole page (body font, background, `.lab` classes). For only the colour tokens and a reset, import `@studio/lab-kit/base.css` instead.

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

