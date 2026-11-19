# Observable Plot (`@observablehq/plot`)

Fast, good-looking statistical charts with very little code. Built on D3.

```ts
import * as Plot from "@observablehq/plot";

function draw(data: { x: number; y: number; group: string }[]) {
  const chart = Plot.plot({
    width: 640, height: 360,
    x: { label: "Height (cm)" },
    y: { label: "Count", grid: true },
    color: { legend: true },
    marks: [
      Plot.rectY(data, Plot.binX({ y: "count" }, { x: "x", fill: "group" })),   // histogram
      Plot.ruleY([0]),
    ],
  });
  chart.setAttribute("data-part", "histogram");
  document.querySelector("#chart")!.replaceChildren(chart);
}
```

Common marks: `Plot.dot` (scatter), `Plot.lineY` / `Plot.line`, `Plot.barY`, `Plot.rectY` + `Plot.binX` (histogram), `Plot.boxY`, `Plot.areaY`, `Plot.linearRegressionY`, `Plot.text`, `Plot.ruleX/ruleY`, `Plot.density`.

- Re-render the whole plot when inputs change (it is cheap). Replace the old element with `replaceChildren`.
- Charts are SVG; set `style: { background: "transparent" }` to sit on any background.
- Random data for simulations: `d3.randomNormal(mean, sd)` from `d3`.
