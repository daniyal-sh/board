# manim-web (`manim-web`)

A TypeScript port of Manim Community that renders in the browser (WebGL via Three.js). Same ideas as Python Manim, with **camelCase** names and `await` on animations. Large (~3 MB): use it when you want Manim-style animated maths.

```ts
import {
  Scene, Axes, NumberPlane, Circle, Square, Dot, Line, Arrow, Text, MathTex, DecimalNumber,
  ValueTracker, alwaysRedraw, Create, Write, FadeIn, FadeOut, Transform,
  UP, DOWN, LEFT, RIGHT, ORIGIN, BLUE, YELLOW, RED, GREEN, WHITE,
} from "manim-web";

const container = document.querySelector<HTMLElement>("#stage")!;
const scene = new Scene(container, { backgroundColor: "#0E0E12" });   // 14 x 8 world units, like Manim

const f = (x: number) => 0.09 * (x - 1) * (x - 4) * (x - 7) + 2.4;
const axes = new Axes({ xRange: [-1, 9, 1], yRange: [-1, 6, 1], xLength: 10, yLength: 6 });
const graph = axes.plot(f, { color: BLUE });
const h = new ValueTracker(2.6);
const secant = alwaysRedraw(() => {
  const x0 = 2.2, x1 = x0 + h.getValue();
  return new Line({ start: axes.c2p(x0, f(x0)), end: axes.c2p(x1, f(x1)), color: YELLOW });
});

await scene.play(new Create(axes), new Create(graph));
scene.add(secant);
await scene.play(h.animate.setValue(0.01).withDuration(6));   // duration lives on the animation
const label = new MathTex({ latex: "f'(x)" }).toCorner(UP);
await scene.play(new FadeIn(label, { duration: 0.5 }));
await scene.wait(1);
```

Verify signatures before using anything you are unsure of. The full type declarations are at
`{{LIBS_DIR}}/manim-web/dist/` (start with `index.d.ts`, `core/Scene.d.ts`, `core/Mobject.d.ts`, `mobjects/`). Read them; do not guess from Python Manim.

Differences from Python Manim to remember:
- Durations go on the animation (`{ duration }` option or `.withDuration(s)`), not on `play()`. Rate functions: `rateFunc`.
- `scene.play(...)` and `scene.wait()` return promises: always `await` them, inside an async function or top-level await.
- Methods are camelCase: `moveTo`, `nextTo`, `toEdge`, `toCorner`, `setColor`, `addUpdater`, `getValue`, `setValue`.
- Constructors take one options object: `new Circle({ radius: 1, color: RED })`, `new Line({ start, end })`, `new MathTex({ latex: "x^2" })`, `new Text({ text: "Hi" })`.
- Points are `[x, y, z]` tuples.
- `MathTex` and `Tex` are typeset by MathJax inside the page (no LaTeX install, works offline); stick to standard LaTeX math.
- Interaction: `Slider`, `Draggable`, `Clickable`, `Hoverable` exist; a lab-kit `<lab-slider>` driving a `ValueTracker` is often simpler.
- Give mobjects meaningful variable names: they become the part names teachers click in the preview.
