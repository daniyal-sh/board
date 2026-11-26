# Building a slide deck

A deck is what the teacher presents in class: one slide on the screen at a time, moved on with a click or the arrow keys. Every slide can build up in **steps**. The next click plays the next step, and going back shows the end of the previous step. Slides sit on a **fixed canvas** (1920×1080, or 1080×1920 for a vertical deck) that is scaled to the projector, so what you lay out is exactly what the room sees.

There are two kinds of slide, and a deck mixes them freely:

| Slide | File | Use it for |
|---|---|---|
| **Animated** | `scenes/NN_name.py` (Manim engine) or `scenes/NN_name.ts` (manim-web engine) | Maths and science that moves: constructions, transformations, graphs being drawn, proofs that build. |
| **HTML** | `scenes/NN_name.html` | Titles, bullet points, images, tables, quotes, questions to the class, and **interactive** slides (a live JSXGraph construction, a simulation, a poll-style check) the teacher can use while presenting. |

AGENTS.md says which engine this deck uses. Only write animated slides for that engine.

## Files

```
scenes/01_title.html       slides, in filename order
scenes/02_secant.ts        (or .py with the Manim engine)
scenes/03_explore.html
scenes/_theme.css          optional: deck-wide styles (colours, fonts, shared classes)
scenes/assets/…            images and data used by HTML slides
notes/02_secant.md         speaker notes for a slide (shown to the teacher while presenting)
narration/02_secant.md     optional voice-over for animated slides ({{mark:name}} cues, as for videos)
```

Number the files in deck order (`01_`, `02_` …). To reorder, rename. Do not edit `scenes/index.ts` or anything in `build/`.

## HTML slides

An HTML slide is a **fragment**: the content of the slide, with no `<html>`, `<head>` or `<body>`. It may contain one `<style>` block (scoped to this slide automatically) and one `<script type="module">` block (bundled, so you can import the libraries from the Lab guide).

```html
<!-- title: Why the tangent? -->
<h2 data-part="heading">Why the tangent?</h2>
<ul>
  <li data-step="1">A secant joins two points on the curve.</li>
  <li data-step="2">Slide the points together…</li>
  <li data-step="3" data-step-effect="up">…and the secant becomes the <b>tangent</b>.</li>
</ul>
```

- `<!-- title: … -->` names the slide in the storyboard (otherwise the first heading is used). `<!-- class: title -->` puts layout classes on the slide itself.
- **Steps**: `data-step="n"` makes an element appear at step n (step 0 is the slide as it first appears). `data-step-hide="n"` removes an element at step n. `data-step-effect="up" | "left" | "zoom" | "dim"` changes how it appears (`dim` keeps it visible but greyed until its step). An element on the current step also gets the class `deck-step-current`, which you can style.
- The house style is dark (like Manim), with large type: `h1` 96 px, `h2` 68 px, body 40 px. **Never go below 28 px**: slides are read from the back of a room. Keep it to about 6 lines of text per slide.
- Layout helpers: `title` (centred title slide), `top` (content starts at the top), `columns` (two columns; `wide-left`, `wide-right`), `stack`, `row`, `center`, `fill`, `box` (a panel), `big`, `small`, `muted`, and the Manim colours `blue yellow red green purple`. CSS variables: `--deck-bg`, `--deck-surface`, `--deck-ink`, `--deck-muted`, `--deck-accent`, `--deck-blue` … `--deck-purple`.
- Images: `<img src="assets/cell.png" alt="…">` with the file in `scenes/assets/`. It is inlined at build time. No URLs from the internet.
- Math: in a slide script, `import { renderMath } from "@studio/lab-kit/math"; renderMath(thisSlide());` typesets `$…$` and `$$…$$` in that slide.

### Interactive HTML slides

```html
<!-- title: Try it -->
<!-- class: top -->
<h2>Drag the point</h2>
<div id="board" class="fill" data-part="board" style="aspect-ratio:16/9"></div>
<script type="module">
  import JXG from "jsxgraph";
  import "jsxgraph/distrib/jsxgraph.css";
  import { thisSlide } from "@studio/lab-kit/deck";

  const slide = thisSlide();                 // this slide's <section>; query inside it
  const board = JXG.JSXGraph.initBoard(slide.querySelector("#board"), { boundingbox: [-5, 5, 5, -5], axis: true, showCopyright: false });
  const p = board.create("point", [1, 2], { name: "P", size: 6 });

  export function onStep(step) { /* called with the step now shown */ }
  export function onEnter() { board.fullUpdate(); }   // the slide came on screen
  export function onLeave() { /* stop timers, pause simulations */ }
  // export const steps = 3;                 // when the steps are driven by code, not data-step
</script>
```

- Use `thisSlide().querySelector(…)`, not `document.querySelector`: every slide is in the page at once, so ids may repeat across slides.
- On a slide with a script, a click goes to the slide's own controls and does **not** advance the deck (keys still do). Put `data-click-advances` on the slide's outer element to change that. Make controls large: they are used on a projector, often with a mouse from a lectern.
- Stop animations and timers in `onLeave` and restart them in `onEnter`.
- The rules for Labs apply: `data-part` names, real buttons and labels, `prefers-reduced-motion`.

## Animated slides: manim-web engine (`.ts`)

Read `libs/manim-web.md` first. An animated slide is a scene from the web-animation guide, plus `nextSlide()`:

```ts
import { Axes, Create, Write, MathTex, BLUE, UP } from "manim-web";
import type { SlideScene } from "@studio/lab-kit/deck-web";

export const title = "The curve";

export default async function (scene: SlideScene) {
  const axes = new Axes({ xRange: [-1, 9, 1], yRange: [-1, 6, 1] });
  const graph = axes.plot((x) => Math.sin(x) + 2, { color: BLUE });
  await scene.play(new Create(axes));
  await scene.nextSlide();                     // step 0 ends: the axes are on screen
  await scene.play(new Create(graph));
  await scene.nextSlide({ loop: true });       // step 1 replays until the presenter clicks
  await scene.play(new Write(new MathTex({ latex: "y = \\sin x + 2" }).toEdge(UP)));
}                                              // the end of the slide is always the last stop
```

- Step 0 plays as soon as the slide comes up. Call `await scene.nextSlide()` before the first animation if the slide should wait for a click first.
- Each slide starts on an empty stage; you don't need to clear it at the end.
- `await scene.waitUntil("mark")` follows the voice-over, as in web animations.

## Animated slides: Manim engine (`.py`)

Read `video.md` first. An animated slide is a `StudioScene`, plus `self.next_slide()`:

```python
from manim import *
from studio_manim import StudioScene


class TheCurve(StudioScene):
    """The curve"""

    def construct(self):
        axes = Axes(x_range=[-1, 9, 1], y_range=[-1, 6, 1])
        graph = axes.plot(lambda x: np.sin(x) + 2, color=BLUE)
        self.play(Create(axes))
        self.next_slide()                  # step 0 ends here
        self.play(Create(graph))
        self.next_slide(loop=True)         # step 1 replays until the presenter clicks
        self.play(Write(MathTex(r"y = \sin x + 2").to_edge(UP)))
```

- Each `.py` slide is rendered to its own clip. `render_preview` renders the slide you name (or the last one you changed).
- Step 0 plays as soon as the slide comes up; call `self.next_slide()` first if it should wait.
- Don't fade everything out at the end; the next slide is a cut.

## Speaker notes

`notes/<slide>.md` is plain text the teacher sees on the presenter screen: what to say, questions to ask, timings. Write short notes for every slide unless the teacher says otherwise. Notes are not shown to students.

## How to make a good deck

1. One idea per slide. A title that says the idea ("The tangent is the limit of secants"), not the topic ("Tangents").
2. Build up: reveal a list item by item, draw a diagram in steps. Each step is one click for the teacher, so a slide rarely needs more than 4–6.
3. Alternate: an explanation, a picture or animation, then something for the class to do (predict, discuss, try the interactive slide).
4. Start with a title slide and end with a summary or a question.
5. Big and few: large type, high contrast, at most about 6 lines.

## Check your work

After each change call `render_preview` (it builds the deck and reports errors, layout problems on each slide step and console errors). Then call `get_keyframes`: one picture per step of every slide (or one slide with `scene`). For interactive slides, call `interact` with `scene` set to that slide to use its controls. Fix overlaps, text off the slide, text that is too small and empty steps before you reply.
