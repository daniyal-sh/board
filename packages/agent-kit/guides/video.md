# Building a video (Manim Community)

Videos are rendered on the teacher's computer with Manim Community Edition (Python). The app runs the renders for you through the `render_preview` tool; you do not have shell access.

## Files

```
scenes/01_hook.py        one Scene class per file, rendered in filename order
scenes/02_curve.py
narration/01_hook.md     optional narration with sync marks
```

```python
from manim import *
from studio_manim import StudioScene   # Scene + narration sync + part tracking


class TheCurve(StudioScene):
    """The curve"""        # first docstring line is the storyboard title

    def construct(self):
        f = lambda x: 0.09 * (x - 1) * (x - 4) * (x - 7) + 2.4
        axes = Axes(x_range=[-1, 9, 1], y_range=[-1, 6, 1], x_length=10, y_length=6)
        graph = axes.plot(f, color=BLUE)
        self.play(Create(axes), Create(graph))
        self.wait_until("secant")          # waits for the narration mark; plain wait(1) without narration
        x0, h = 2.2, ValueTracker(2.6)
        secant_line = always_redraw(lambda: Line(
            axes.c2p(x0, f(x0)), axes.c2p(x0 + h.get_value(), f(x0 + h.get_value())), color=YELLOW))
        self.play(Create(secant_line))
        self.wait_until("shrink")
        self.play(h.animate.set_value(0.01), run_time=6, rate_func=smooth)
        self.play(FadeOut(*self.mobjects))   # leave the stage clean
```

## Rules

1. Exactly one `StudioScene` subclass per file. Class names are CamelCase and unique.
2. One idea per scene, 10–40 seconds. Clear the stage at the end.
3. **Name things.** Assign mobjects to descriptive variables (`secant_line`, `tangent_label`). The app records those names so the teacher can click an object in the preview and you receive its name and line number.
4. Stay inside the frame (14.2 × 8 units). Use `to_edge`, `to_corner`, `next_to(buff=...)`, `arrange`. Keep text readable: `font_size` ≥ 32 for body text.
5. LaTeX is installed: `MathTex` and `Tex` work. Use raw strings: `MathTex(r"\frac{dy}{dx}")`.
6. Default background is dark; use the Manim palette (BLUE, YELLOW, RED, GREEN, PURPLE, WHITE, GREY).
7. Prefer standard Manim CE APIs (v0.19+). No external assets or network.
8. After each change: `render_preview` (low quality, fast) → fix any Python error it returns → `get_frames` at several timestamps to check overlaps, cut-off text and pacing.

## Narration

Narration lives in `narration/<scene>.md`. Put `{{mark:name}}` before the word an animation should start on:

```
Here's a curve. Join two points with a {{mark:secant}} secant line. As h gets {{mark:shrink}} smaller, it swings toward the tangent.
```

In the scene, call `self.wait_until("secant")` before the matching `self.play(...)`. The app generates the voice (AI or the teacher's recording), finds when each mark is spoken, and the scene waits for it. Scene length then follows the voice. Without narration, `wait_until` waits a sensible default.

## Converting to a web animation

When asked to convert a video to a web animation, rewrite each scene by hand in manim-web (see `web.md` and `libs/manim-web.md`). Do not translate mechanically: manim-web uses camelCase methods, options objects and `await` on every `play`. Check each scene with `render_preview` and `get_frames`.
