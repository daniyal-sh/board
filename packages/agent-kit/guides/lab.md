# Building a Lab

A Lab is an interactive web page a teacher shares with students. It is not a video: students poke at it, change values, predict, and check themselves. The teacher steers what it should be.

**There is no required template.** Pick the form that fits the idea and the teacher's request, and design the page for it. A Lab can be a single full-screen simulation, a scrolling essay with live figures, a puzzle, or a classic "sliders and a picture" page. The lab kit (`@studio/lab-kit`) is one option among the libraries, not the default look.

## Files

```
lab/index.html   page markup. Keep the <script type="module" src="./main.ts"></script> tag; the builder replaces it.
lab/main.ts      entry point (TypeScript or plain JS). Import libraries and lab/style.css here.
lab/style.css    page styles
lab/assets/      images or data files you import from main.ts (they get inlined)
```

The builder bundles everything into **one self-contained HTML file** with no network access. So:

- Import libraries by name (`import JXG from "jsxgraph"`). Never use CDN URLs, `fetch()` to the internet, or web fonts from Google.
- Only the libraries listed below are available. Do not `npm install` anything.
- Keep the page light: prefer one main library. Three.js, p5.js and manim-web are large (1–3 MB); use them when they are the point.

## Forms that work

Choose one, or combine two. Name the form to yourself before you write any code.

| Form | What it is | Good for |
|---|---|---|
| **Interactive figure** | One big picture with a few controls (sliders, draggable points) and a live readout. | Seeing how a parameter changes a graph, a shape or a system. |
| **Explorable essay** | A short readable text with small live figures and numbers you can drag *inside* the sentences. | Building an argument step by step: "if the rate were [5]%, the money doubles in **14** years". |
| **Scrollytelling** | A sticky figure that changes as the reader scrolls through short paragraphs (use `IntersectionObserver`). | Narrated explanations with a single evolving diagram. |
| **Simulation** | A full-screen canvas running live (physics, population, particles), with play/pause/reset and a few knobs. | Systems that are best understood by watching them run. |
| **Predict, then reveal** | Students commit to an answer (a choice, a sketch, a number) before the page shows what happens. | Confronting misconceptions. |
| **Puzzle or game** | A target to hit, a pattern to complete, a level to beat, with instant feedback. | Practice and motivation. |
| **Step-through proof** | Buttons or keys move through the steps of a derivation or construction; each step highlights what changed. | Proofs, algorithms, worked examples. |
| **Manipulative** | Virtual blocks, tiles, fraction bars, number lines or balance scales to drag around. | Younger students, concrete-to-abstract work. |
| **Sandbox / playground** | A free canvas with tools (place charges, draw a function, build a circuit). | Open exploration after the main idea is taught. |

Design for the form: an essay wants a comfortable reading column and serif type; a simulation wants the canvas edge to edge; a game wants big targets and a score. Don't put everything in cards by habit.

## Available libraries

| Import | Use it for | Guide |
|---|---|---|
| `jsxgraph` | interactive geometry and function graphs, draggable points, built-in sliders | libs/jsxgraph.md |
| `d3` | custom data visualisation, scales, axes, transitions, force layouts | libs/d3.md |
| `@observablehq/plot` | quick statistical charts (histograms, scatter, line) | libs/plot.md |
| `matter-js` | 2D physics: collisions, ramps, pendulums, springs | libs/matter.md |
| `gsap` | timeline animations of SVG/HTML, step-by-step explanations, scroll-linked motion | libs/gsap.md |
| `p5` | creative coding and quick simulations on a canvas (instance mode) | libs/p5.md |
| `roughjs` | hand-drawn, whiteboard-style shapes on SVG or canvas | libs/rough.md |
| `three` | 3D: solids, vectors, surfaces, molecules | libs/three.md |
| `manim-web` | Manim-style animated math scenes (TypeScript port of Manim) | libs/manim-web.md |
| `@studio/lab-kit/math` | math typesetting (KaTeX): `$...$` in HTML, `tex()` in code | libs/katex.md |
| `@studio/lab-kit` | ready-made sliders, step-through, checks, reveal, canvas helpers and a house style | libs/lab-kit.md |
| `@studio/lab-kit/base.css` | just the colour tokens (light/dark, Manim palette) and a small reset, without any components | libs/lab-kit.md |

Plain Canvas 2D, inline SVG, CSS animations and the Web Animations API need no library and are often the best choice. Native `<input type="range">`, `<details>`, `<dialog>` and `<button>` are fine; style them.

## Rules that make Labs good

1. **Name the parts.** Put `data-part="snake_case_name"` on every meaningful element (canvases, panels, readouts, buttons). Teachers click parts in the preview to ask for changes, and you receive that name. Lab kit elements get one from their `name` automatically.
2. **Works on a phone.** Layouts reflow under 720px (CSS grid or flex that stacks). Canvases scale to their container width and stay sharp (multiply by `devicePixelRatio`). Touch works: use pointer events, not mouse events, and `touch-action: none` on things you drag.
3. **Accessible.** Real `<button>`s, labels on inputs, keyboard access to every control, enough contrast, no information carried by colour alone. Respect `prefers-reduced-motion` (shorter or no animation).
4. **Light and dark.** Follow the student's setting with `prefers-color-scheme`, or import `@studio/lab-kit/base.css` and use its variables (`--lab-bg`, `--lab-ink`, `--lab-accent`, `--manim-blue` …). Give `body` an explicit background.
5. **Explain on the page.** Short instructions where students need them. Use the teacher's level and language.
6. **Correct.** Get the science and maths right. Show units. Label axes.
7. **Self-check.** After building, call `render_preview` (it checks desktop and phone layouts), then `get_keyframes` to look at both, and `interact` to try every control like a student would. Fix anything cramped, overlapping, blank or unresponsive.
