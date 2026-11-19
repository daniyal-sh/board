# JSXGraph (`jsxgraph`)

Interactive geometry and graphing: draggable points, constructions that update live, function plots, built-in sliders. The closest thing to GeoGebra/Desmos that works offline.

```ts
import JXG from "jsxgraph";
import "jsxgraph/distrib/jsxgraph.css";
```

```html
<div id="board" class="lab-card" style="aspect-ratio: 4 / 3; padding: 0" data-part="board"></div>
```

```ts
const board = JXG.JSXGraph.initBoard("board", {
  boundingbox: [-5, 5, 5, -5],   // [left, top, right, bottom]
  axis: true,
  showCopyright: false,
  showNavigation: false,
  keepAspectRatio: true,
});

const a = board.create("slider", [[-4, 4], [0, 4], [-3, 1, 3]], { name: "a" });   // [start, end, [min, value, max]]
const f = board.create("functiongraph", [(x: number) => a.Value() * x * x, -5, 5], { strokeColor: "#58C4DD", strokeWidth: 3 });

const P = board.create("point", [1, 1], { name: "P", color: "#FC6255" });         // draggable
const Q = board.create("point", [3, 2], { name: "Q" });
board.create("line", [P, Q], { strokeColor: "#FFE14D" });
board.create("segment", [P, Q]);
board.create("circle", [P, Q]);                        // centre P through Q
board.create("glider", [2, 0, f]);                     // point that slides along f
board.create("tangent", [board.create("glider", [1, 1, f])]);
board.create("text", [-4, -4, () => `slope = ${((Q.Y() - P.Y()) / (Q.X() - P.X())).toFixed(2)}`]);

P.on("drag", () => { /* update readouts */ });
board.update();
```

- Values update automatically when anything depends on them through functions (`() => P.X()`).
- Element types: `point`, `glider`, `line`, `segment`, `arrow`, `circle`, `polygon`, `angle`, `functiongraph`, `curve`, `slider`, `text`, `intersection`, `midpoint`, `perpendicular`, `parallel`, `tangent`, `integral`, `riemannsum`.
- Lab kit sliders work too: read `slider("a").value` inside a function the board calls, then `board.update()` on change.
- Board colours: set `strokeColor` / `fillColor` explicitly; the board background is white by default.
