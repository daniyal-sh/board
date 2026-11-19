# Building a web animation (manim-web)

A web animation is a Manim-style animated explanation that plays in the browser and can be shared as a link. It is watched more than explored, but it can include light interaction.

Read `libs/manim-web.md` first, and check the manim-web type declarations whenever you are unsure of a signature.

## Files

```
scenes/01_hook.ts       one scene per file, played in filename order
scenes/02_curve.ts
narration/01_hook.md    optional narration for the scene (see below)
```

Each scene file exports a default async function that receives the shared `Scene`:

```ts
import { Scene, Axes, Create, FadeOut, BLUE } from "manim-web";

export const title = "The curve";          // shown in the storyboard

export default async function (scene: Scene) {
  const axes = new Axes({ xRange: [-1, 9, 1], yRange: [-1, 6, 1] });
  const graph = axes.plot((x) => Math.sin(x) + 2, { color: BLUE });
  await scene.play(new Create(axes), new Create(graph));
  await scene.wait(1);
  await scene.play(new FadeOut(axes), new FadeOut(graph));   // leave the stage clean for the next scene
}
```

Do not edit `scenes/index.ts`; the app generates it.

## Rules

1. One idea per scene, 10–40 seconds each. Clear the stage at the end of every scene.
2. Name mobjects with descriptive variables (`secantLine`, `tangentLabel`); those names identify parts the teacher clicks.
3. Keep text large and on screen: the frame is 14 × 8 units. Use `toEdge`, `toCorner`, `nextTo` with buffers instead of raw coordinates where you can.
4. Use the Manim palette (BLUE, YELLOW, RED, GREEN, PURPLE, WHITE) on the dark background.
5. After each change: `render_preview` for the scene, `get_console` (fix errors), then `get_frames` at a few times to check layout and overlaps.

## Narration

If the teacher wants narration, write it in `narration/<scene>.md`, one paragraph per beat. Mark the word an animation should start on with `{{mark:name}}`:

```
Join two points with a {{mark:secant}} secant line. As h gets {{mark:shrink}} smaller...
```

In the scene, wait for marks with `await scene.waitUntil?.("secant")` (the app provides this when narration exists; it is a no-op otherwise).
