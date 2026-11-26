# Plan: Decks (interactive slides) and freer HTML

Status: draft for review. Nothing here is built yet.

## Decisions so far

| Question | Decision |
|---|---|
| How slides fit in | A new 4th project kind, **Deck**. Each slide is one of: manim-web animation, HTML (static or interactive), or Manim video. Mixed freely. |
| Python Manim slides | **Native** in `studio_manim`: `self.next_slide()` writes stop points into the existing timeline. No manim-slides dependency. |
| Engine | **Custom**, built on Board's own timeline (Player, segments, cues). No reveal.js. |
| HTML | **Lab-kit becomes optional everywhere.** Labs and HTML slides can be any page; the offline single-file build stays. |
| New libraries | **p5.js** and **Rough.js**. |
| First-version presenting | Presenter view, pen and laser, export to one HTML / PDF / PPTX. |
| Not now | Students following on phones (needs a local server), Pyodide, reveal.js. |

The core idea: a slide is a **span of a timeline with stop points**. Space or → plays to the next stop and waits.
That is how manim-slides works, and it is how Board's web runner already works (one `Player` timeline,
`segments` per scene, `cues` per `{{mark}}`). A stop is a new kind of cue that holds the playhead until
the presenter advances.

---

## Phase 1: freer HTML (small; ships on its own)

**Goal:** the assistant builds whatever page fits the idea (scrollytelling, explorable essay, canvas
simulation, small game, visual proof, step-through) instead of defaulting to the lab-kit layout.

1. **Guide rewrite**: `packages/agent-kit/guides/lab.md`
   - Lead with *forms that work* (one short paragraph each, with when to pick it): interactive figure,
     explorable essay, scrollytelling, simulation with controls, predict–reveal, puzzle or game,
     step-through proof, visual dictionary.
   - Lab-kit moves into its own guide, `guides/libs/lab-kit.md`, framed as "use when sliders, checks
     and steps are what you need".
   - The hard rules stay: offline single file, `data-part` names, works on a phone, accessible,
     `prefers-reduced-motion`, light/dark.
2. **Starter template** (`packages/agent-kit/src/index.ts` `templates("lab")`): a neutral page with no
   `.lab` class and no lab-kit import. A tiny base stylesheet (system font stack, light/dark tokens)
   so a blank page still looks right. The assistant adds `import "@studio/lab-kit"` when it wants it.
3. **New libraries**
   - Add `p5` and `roughjs` to `packages/lab-kit/package.json`.
   - Add them to `KNOWN_LIBS` in `apps/desktop/src/main/build/bundle.ts` and to the reach entry in
     `scripts/vendor-lab-kit.mjs`.
   - Write `guides/libs/p5.md` (instance mode only, `new p5(sketch, el)`, since global mode collides
     with other code; sizing to the container; pointer events) and `guides/libs/rough.md`
     (`rough.svg` / `rough.canvas`, fixed `seed` so redraws don't jitter, and when a hand-drawn look helps).
4. **Selftest**: `build` mode gains a p5 sample and a Rough.js sample.

---

## Phase 2: Deck core (manim-web and HTML slides)

### Project on disk

```
project.json            kind: "deck", aspect (16:9 default, 9:16 allowed)
slides/01_title.html    HTML slide: a fragment (no <html>/<head>), optional sibling .ts and .css
slides/02_secant.ts     manim-web slide: default export async (scene) => …, uses scene.nextSlide()
slides/03_explore.html  interactive HTML slide…
slides/03_explore.ts    …with its script
slides/04_proof.py      Manim video slide (phase 3)
notes/<slide>.md        speaker notes (presenter view, PPTX notes)
narration/<slide>.md    optional voice-over, same {{mark:…}} cues as today
deck/theme.css          optional deck-wide styles
```

`scanScenes` (`apps/desktop/src/main/projects.ts`) learns `slides/` with the three extensions.
`SceneMeta` gains `slideType: "web" | "html" | "video"` and `steps?: number`.

### Shared types (`packages/shared/src/project.ts`)

- `ProjectKind` adds `"deck"`; `PROJECT_KINDS.deck = { label: "Slides", engine: "manim-web + HTML", … }`.
- `DeckStop { slide: string; step: number; t?: number }`: where the presenter can land.

### Steps inside a slide

| Slide type | How the author makes a step | How Board finds it |
|---|---|---|
| manim-web | `await scene.nextSlide()` (`{ loop: true }` loops the part before it, as in manim-slides) | Recorded as a cue of kind `stop` in the Player timeline |
| HTML | `data-step="1"`, `data-step="2"` on elements (shown cumulatively); optional `export function onStep(n)` in the `.ts` | Highest `data-step`, read at build |
| video | `self.next_slide()` | `"kind": "stop"` entry in the timeline JSON (phase 3) |

Going back a step jumps to the end state of the previous step instead of playing in reverse. That's
predictable and needs no reverse render. A manim-web slide seeks; an HTML slide hides steps above `n`
and calls `onStep(n)`.

### Runtime (`apps/desktop/src/main/build/deck-runner.ts`, generated like `web-runner.ts`)

- **Stage**: a fixed logical canvas (1920×1080, or 1080×1920 vertical) scaled with a CSS transform to
  fit. Layout is the same on every screen and in export.
- **One `SlideHost` interface** with `enter(step)`, `goto(step)`, `leave()`, `steps` and an optional
  `timeline` for the scrubber. There are three hosts:
  - `WebSlideHost`: all manim-web slides share **one** Player timeline, as today, so a Transform can
    carry objects from one slide into the next (reveal.js-style auto-animate for free). Each slide is a
    segment; stops are cues.
  - `HtmlSlideHost`: the slide fragment sits in a container with its own scope (CSS from the slide's
    own `.css` is wrapped in `@scope`). Interactive widgets mount on `enter` and are torn down on `leave`.
  - `VideoSlideHost`: `<video>` with pause-at-stop (phase 3).
- **Navigation**: Space / → / PageDown / click next; ← / PageUp back; Home/End; number keys plus Enter to
  jump; `O` overview grid; `B` black screen; `F` full screen. Inside an interactive widget the keys go to
  the widget, Esc hands them back to the deck, and a small focus ring shows which one has them.
- Speaks the same `postMessage` protocol as the web runner (`player.state`, `seek`…), plus `goto`,
  `step` and `deck.state`, so `WebPreview`/`WebStage` can drive it with minimal changes.

### In the app

- Home: a 4th card, "Slides".
- Studio: the storyboard shows slides with their step count. The timeline shows a **slide track**
  (slide blocks with step ticks) above the existing step, cue and voice tracks. A manim-web or video
  slide also shows its animation steps.
- A **Present** button opens full screen at the current slide (phase 4 adds presenter view).
- Click-to-edit works as it does now: `data-part` for HTML, mobject variable names for manim-web, and
  `studio_manim` boxes for video.

### Assistant

- `guides/deck.md`: what makes a good slide (one idea, large type, at most about 6 lines, build it up in
  steps), when to pick each slide type, steps, and speaker notes in `notes/`.
- `agent-kit` `projectInstructions`, `systemAppend`, `KIND_GUIDE`, `templates("deck")` (starter
  `slides/01_title.html`).
- Tools: `render_preview` takes a slide; `get_keyframes` returns **one frame per step per slide**;
  `interact` works on HTML slides; `get_view` and `get_selection` report slide and step. Layout checks
  run on the logical canvas.
- Selftest mode `deck`: a sample deck with one slide of each type, screenshots per step.

---

## Phase 3: Manim video slides

- `python/studio_manim/__init__.py`: `StudioScene.next_slide(loop=False)` calls `self._record(..., kind="stop")`
  with `start == end`, and adds a short wait so the stop has a distinct frame. `loop=True` marks the
  span since the previous stop as a loop.
- `apps/desktop/src/main/video/renderer.ts`: render `slides/*.py` like `scenes/*.py`. The timeline JSON
  already carries `plays`; the deck reads the `stop` entries from it.
- `VideoSlideHost`: plays the draft or HQ MP4, pauses at each stop time, loops a loop span until you
  advance. Back = seek to the previous stop.
- Narration and `wait_until` work unchanged.

---

## Phase 4: presenting

### Presenter view

- In the app: **Present** opens an *audience* `BrowserWindow`, frameless and full screen on the second
  display when there is one. The main window switches to the presenter layout: current slide (live),
  next step (still), notes from `notes/<slide>.md`, a timer and slide/step count, and navigation
  buttons.
- **Live mirror**: interactive slides must not run twice, or the two copies drift apart. The audience
  window is the one that runs. The presenter's "current" pane mirrors it with
  `webContents.beginFrameSubscription` (or a `desktopCapturer` stream of that window) and forwards the
  presenter's pointer to the audience window. Prototype both and pick whichever has lower latency.
- **In the exported HTML**: press `S` to open a speaker tab (as reveal.js does). The tabs sync slide, step
  and ink with `BroadcastChannel`. Here each tab runs its own copy and the speaker tab's current pane is
  a non-interactive still.

### Pen and laser

- An overlay `<canvas>` above the stage, in **logical stage coordinates**, so ink stays put when the
  window resizes and lines up across windows.
- `P` pen (three colours, two widths), `H` highlighter, `L` laser pointer (fading trail), `E` eraser,
  `C` clear. In pointer mode the overlay has `pointer-events: none`, so interactive slides still work.
- Ink belongs to a slide step. It's cleared on advance by default, with a pin option to keep it.
- Ink and the laser are broadcast to the audience window (IPC in the app, `BroadcastChannel` in the
  export).
- Not saved to the project in v1. A later option is "save ink as an annotation layer".

---

## Phase 5: export

All three formats build on the existing hidden-window stepping used for web GIFs (`preview.ts`).

| Format | What you get | How |
|---|---|---|
| **One HTML** | The whole deck with navigation, steps, pen and laser, and the speaker tab. Offline. | `deck-runner` plus all slides bundled and inlined. Video slides' MP4s are inlined as base64. Above about 50 MB, offer a **folder export** (`deck.html` + `media/`) instead. |
| **PDF** | One page per step (default) or per slide (final state), with notes optional. | Step through in a hidden window at the logical size and capture each page. Combine with `webContents.printToPDF` on a generated page of images, or with pdf-lib. |
| **PPTX** | One slide per step as an image, speaker notes kept. Video slides are embedded as MP4 clips cut at the stops. | `pptxgenjs` (MIT) in the main process. A manim-web slide stays an image per step in v1. Embedding it as video needs a WebM recording from the hidden window, which comes later. |

---

## Later

- Self-running decks: narration auto-advances stops, and the whole deck exports as a video.
- Students follow on their phones over the local network (needs a small local server, behind an explicit opt-in).
- Pyodide slides and Labs (live Python), as an optional download like Manim.
- Turning a Lab or web animation into a deck slide ("add to deck").

## Open questions for review

1. **Steps going back**: jump to the end of the previous step (proposed), or play in reverse like manim-slides? Reverse needs a reverse render for video slides.
2. **Notes and narration**: keep them separate files (proposed), or start notes from the narration script?
3. **Fixed 1920×1080 canvas** (proposed) vs. responsive slides that reflow on a phone. Fixed is better for presenting and export; responsive is better for decks students open on their own phones.
4. **Size limit for one-file export with video slides**: what's acceptable before we switch to a folder export?
5. **Vertical (9:16) decks**: worth supporting in v1?
6. Should **web animation** projects also get `scene.nextSlide()` (a pause point in a normal web animation)? It costs almost nothing once phase 2 exists.
