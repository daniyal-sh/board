# Rough.js (`roughjs`)

A hand-drawn, sketchy look for shapes on SVG or canvas, like a whiteboard or a notebook. Small (about 30 KB). It makes diagrams feel informal and friendly, and it is good for "teacher's sketch" figures, hand-drawn annotations over a figure, and younger audiences. Use it for diagrams and accents, not for precise plots that students must read values from.

```ts
import rough from "roughjs";

// SVG: each call returns a <g> you append.
const svg = document.querySelector<SVGSVGElement>("#diagram")!;   // <svg id="diagram" viewBox="0 0 600 360" data-part="diagram">
const rc = rough.svg(svg);
const opts = { seed: 7, roughness: 1.2, stroke: "currentColor", strokeWidth: 2 };
svg.append(
  rc.rectangle(40, 60, 200, 120, { ...opts, fill: "#58C4DD", fillStyle: "hachure", hachureGap: 8 }),
  rc.circle(400, 120, 140, { ...opts, fill: "#FFE14D", fillStyle: "cross-hatch" }),
  rc.line(240, 120, 330, 120, opts),
  rc.path("M 80 300 Q 300 200 520 300", opts),
);

// Canvas: draws straight onto the canvas.
const rcCanvas = rough.canvas(document.querySelector("canvas")!);
rcCanvas.ellipse(150, 100, 200, 120, { seed: 3, fill: "#83C167", fillStyle: "zigzag" });
```

- **Always pass a fixed `seed`** (any integer). Without it every redraw wobbles differently, which looks like jitter when something animates or re-renders.
- Shapes: `line`, `rectangle`, `ellipse`, `circle`, `linearPath(points)`, `polygon(points)`, `arc(x, y, w, h, start, stop, closed)`, `curve(points)`, `path(svgPathData)`.
- Options: `roughness` (0 = clean, 1 = default, 2+ = very sketchy), `bowing`, `stroke`, `strokeWidth`, `fill`, `fillStyle` (`hachure`, `solid`, `zigzag`, `cross-hatch`, `dots`, `dashed`, `zigzag-line`), `hachureGap`, `hachureAngle`.
- Pair it with a handwriting-style font only if you have one to import from `lab/assets/` (no web fonts); otherwise use a clean system font for labels so text stays readable.
- Draw-on animation: SVG paths from Rough.js can be animated with `stroke-dasharray` / `stroke-dashoffset` (see libs/gsap.md), or reveal parts with opacity transitions.
- `stroke: "currentColor"` lets shapes follow the page's light/dark text colour.
- Rough.js only draws. For dragging or physics, keep your own state and redraw (clear the `<g>` or canvas first, same seed).
