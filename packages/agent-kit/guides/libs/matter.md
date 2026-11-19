# Matter.js (`matter-js`)

2D rigid-body physics: falling, collisions, friction, ramps, pendulums, springs, Newton's cradle.

```ts
import Matter from "matter-js";
const { Engine, Render, Runner, Bodies, Body, Composite, Constraint, Mouse, MouseConstraint, Events } = Matter;

const host = document.querySelector<HTMLElement>("#world")!;
const engine = Engine.create();                       // gravity: engine.gravity.y = 1 (default)
const render = Render.create({
  element: host, engine,
  options: { width: 720, height: 405, wireframes: false, background: "#0E0E12", pixelRatio: window.devicePixelRatio },
});
render.canvas.style.width = "100%"; render.canvas.style.height = "auto";
render.canvas.dataset.part = "physics_world";

const ground = Bodies.rectangle(360, 400, 760, 20, { isStatic: true, render: { fillStyle: "#43434D" } });
const ball = Bodies.circle(120, 80, 18, { restitution: 0.8, render: { fillStyle: "#FFE14D" } });
const ramp = Bodies.rectangle(300, 260, 400, 14, { isStatic: true, angle: Math.PI / 10 });
const bob = Bodies.circle(560, 200, 16);
const rope = Constraint.create({ pointA: { x: 560, y: 40 }, bodyB: bob, length: 160, stiffness: 1 });
Composite.add(engine.world, [ground, ball, ramp, bob, rope]);

Composite.add(engine.world, MouseConstraint.create(engine, { mouse: Mouse.create(render.canvas) }));   // drag bodies
Render.run(render);
Runner.run(Runner.create(), engine);

Body.setVelocity(ball, { x: 5, y: 0 });
Events.on(engine, "afterUpdate", () => { /* read ball.position, ball.velocity for readouts */ });
```

- Units are pixels and steps, not SI. To show real units, convert (e.g. 50 px = 1 m) and say so on the page.
- Reset: `Composite.clear(engine.world, false)` then re-add bodies, or `Body.setPosition` / `Body.setVelocity`.
- For exact textbook motion (projectiles without collisions), plain maths on a canvas is more accurate than a physics engine.
