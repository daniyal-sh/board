# Plan: Slides and freer HTML

## Decisions

| Question | Decision |
|---|---|
| How slides fit in | One project kind, **Slides**. The teacher picks the engine for the animated slides when creating it: **Manim video** or **manim-web**. HTML slides (static or interactive) work with either. |
| Python Manim slides | Native in `studio_manim`: `self.next_slide()` writes a `stop` into the timeline. No manim-slides dependency. |
| Engine | Custom deck runtime (`packages/lab-kit/src/deck`) on Board's own timelines. No reveal.js. |
| Going back | Shows the end of the previous step (no reverse playback). |
| Canvas | Fixed: 1920×1080 (or 1080×1920 vertical), scaled to the screen. |
| HTML | Lab-kit is optional everywhere; Labs and HTML slides can be any page; the offline single-file build stays. |
| New libraries | p5.js, Rough.js. |
| First-version presenting | Presenter view, pen and laser, export to one HTML / PDF / PPTX. |
| Later | Students following on phones (needs a local server), Pyodide, self-running decks driven by narration. |

## Phases

1. **Freer HTML** (done): Lab guide rewritten around forms that work; `@studio/lab-kit/base.css`; neutral starter page; p5.js and Rough.js.
2. **Slides** (done): the kind and engine choice; `scenes/NN_*.html|.ts|.py`, `notes/`; the deck runtime (steps, keys, click, overview, black screen, HUD); the Slides view (deck preview, step controls, filmstrip, select-to-edit); the Timeline and Voice-over tabs for the animated slides; assistant guide and tools (render_preview checks every step, get_keyframes per step, interact on interactive slides); `self.next_slide()`; MathJax inlined so `MathTex` works offline.
3. **Presenting**: an audience window (full screen on the second display) and a presenter view in the main window (live mirror of the audience screen, next step, notes, timer); pen, highlighter and laser over any slide; the same in the exported file (a speaker tab synced with `postMessage`).
4. **Export**: one HTML file (or a page plus a media folder when clips make it large), PDF (one page per step), PPTX (one slide per step with speaker notes).

## How a deck plays

A slide has steps. Animated slides play on an animator's clock and pause at stops: manim-web slides are recorded into one Player timeline in deck order, Manim slides are one rendered clip each. HTML slides reveal `[data-step="n"]` elements and call the slide script's `onStep(n)`.

- Next: if a step is playing, finish it; otherwise play the next step (the first step of the next slide after the last one).
- Back: show the end of the previous step, paused.
- A looping step (`nextSlide({ loop: true })` / `next_slide(loop=True)`) replays until next.
