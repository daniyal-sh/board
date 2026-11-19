# GSAP (`gsap`)

Timeline animation of SVG and HTML: step-by-step diagrams, morphing labels, highlighting parts of a figure in sequence.

```ts
import { gsap } from "gsap";

const tl = gsap.timeline({ paused: true, defaults: { duration: 0.6, ease: "power2.out" } });
tl.from("#cell .membrane", { opacity: 0, scale: 0.9, transformOrigin: "50% 50%" })
  .from("#cell .nucleus", { opacity: 0, y: 20 }, "+=0.2")
  .to("#label-nucleus", { opacity: 1 }, "<")          // "<" = same time as previous
  .addLabel("organelles")
  .from("#cell .mito", { opacity: 0, stagger: 0.15 });

document.querySelector("#play")!.addEventListener("click", () => tl.restart());
// Scrub with a lab-kit slider: watch(["t"], () => tl.progress(slider("t").value / 100));
// Tie to lab-steps: steps.addEventListener("step", (e) => tl.tweenTo(["start", "organelles", "end"][e.detail]));
```

- Animate `x`, `y`, `scale`, `rotation`, `opacity`, colours, and SVG attributes via `attr: { cx: 100 }`.
- Use `gsap.matchMedia()` or `prefers-reduced-motion` to shorten animations for students who need it.
- Draw strokes on: set `stroke-dasharray`/`stroke-dashoffset` to the path length (`path.getTotalLength()`) and animate `strokeDashoffset` to 0.
