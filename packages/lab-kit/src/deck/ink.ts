/**
 * Pen, highlighter, laser and eraser over any slide while presenting. Ink is drawn in stage
 * coordinates (the fixed slide canvas), so it stays put when the window resizes and lines up in
 * every window showing the deck. With the pointer tool the layer lets clicks through, so
 * interactive slides keep working.
 */
export type InkTool = "pointer" | "pen" | "highlighter" | "laser" | "eraser";

export type InkOp =
  | { op: "start"; id: string; tool: "pen" | "highlighter"; color: string; x: number; y: number }
  | { op: "move"; id: string; x: number; y: number }
  | { op: "end"; id: string }
  | { op: "laser"; x: number; y: number }
  | { op: "erase"; x: number; y: number }
  | { op: "clear" };

interface Stroke {
  id: string;
  tool: "pen" | "highlighter";
  color: string;
  points: { x: number; y: number }[];
}

export const INK_COLORS = ["#FFE14D", "#FC6255", "#58C4DD", "#83C167", "#FFFFFF"];

export interface Ink {
  readonly el: HTMLCanvasElement;
  tool(): InkTool;
  setTool(t: InkTool): void;
  color(): string;
  setColor(c: string): void;
  clear(): void;
  /** Apply an operation from another window showing the same deck. */
  apply(op: InkOp): void;
  hasInk(): boolean;
}

export function createInk(stage: HTMLElement, size: { width: number; height: number }, onOp: (op: InkOp) => void, onTool: (t: InkTool) => void): Ink {
  const el = document.createElement("canvas");
  el.className = "deck-ink";
  el.width = size.width;
  el.height = size.height;
  stage.append(el);
  const ctx = el.getContext("2d")!;
  const strokes: Stroke[] = [];
  const laser: { x: number; y: number; t: number }[] = [];
  let tool: InkTool = "pointer";
  let color = INK_COLORS[0];
  let drawing: Stroke | null = null;
  let seq = 0;
  let laserLoop = 0;

  const pos = (e: PointerEvent) => {
    const r = stage.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * size.width, y: ((e.clientY - r.top) / r.height) * size.height };
  };

  function strokePath(s: Stroke): void {
    const p = s.points;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = s.color;
    ctx.globalAlpha = s.tool === "highlighter" ? 0.38 : 1;
    ctx.lineWidth = s.tool === "highlighter" ? 30 : 6;
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    if (p.length === 1) ctx.lineTo(p[0].x + 0.1, p[0].y);
    // Smooth through the midpoints.
    for (let i = 1; i < p.length - 1; i++) ctx.quadraticCurveTo(p[i].x, p[i].y, (p[i].x + p[i + 1].x) / 2, (p[i].y + p[i + 1].y) / 2);
    if (p.length > 1) ctx.lineTo(p[p.length - 1].x, p[p.length - 1].y);
    ctx.stroke();
    ctx.restore();
  }

  function redraw(): void {
    ctx.clearRect(0, 0, size.width, size.height);
    for (const s of strokes) strokePath(s);
    const now = performance.now();
    while (laser.length && now - laser[0].t > 450) laser.shift();
    if (laser.length) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 1; i < laser.length; i++) {
        const a = 1 - (now - laser[i].t) / 450;
        ctx.strokeStyle = `rgba(255, 64, 64, ${0.6 * a})`;
        ctx.lineWidth = 10 * a + 2;
        ctx.beginPath();
        ctx.moveTo(laser[i - 1].x, laser[i - 1].y);
        ctx.lineTo(laser[i].x, laser[i].y);
        ctx.stroke();
      }
      const head = laser[laser.length - 1];
      if (now - head.t < 450) {
        ctx.shadowColor = "rgba(255, 40, 40, 0.9)";
        ctx.shadowBlur = 24;
        ctx.fillStyle = "#ff3b3b";
        ctx.beginPath();
        ctx.arc(head.x, head.y, 11, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function animateLaser(): void {
    if (laserLoop) return;
    const step = () => {
      redraw();
      laserLoop = laser.length ? requestAnimationFrame(step) : 0;
    };
    laserLoop = requestAnimationFrame(step);
  }

  function eraseAt(x: number, y: number): boolean {
    const before = strokes.length;
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (strokes[i].points.some((p) => Math.hypot(p.x - x, p.y - y) < 28)) strokes.splice(i, 1);
    }
    return strokes.length !== before;
  }

  const apply = (o: InkOp) => {
    if (o.op === "start") {
      strokes.push({ id: o.id, tool: o.tool, color: o.color, points: [{ x: o.x, y: o.y }] });
      redraw();
    } else if (o.op === "move") {
      const s = strokes.find((x) => x.id === o.id);
      if (s) {
        s.points.push({ x: o.x, y: o.y });
        redraw();
      }
    } else if (o.op === "laser") {
      laser.push({ x: o.x, y: o.y, t: performance.now() });
      animateLaser();
    } else if (o.op === "erase") {
      if (eraseAt(o.x, o.y)) redraw();
    } else if (o.op === "clear") {
      strokes.length = 0;
      redraw();
    }
  };

  const local = (o: InkOp) => {
    apply(o);
    onOp(o);
  };

  el.addEventListener("pointerdown", (e) => {
    if (tool === "pointer") return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const p = pos(e);
    if (tool === "pen" || tool === "highlighter") {
      const id = `${Date.now().toString(36)}-${seq++}`;
      drawing = { id, tool, color, points: [] };
      local({ op: "start", id, tool, color, ...p });
    } else if (tool === "eraser") local({ op: "erase", ...p });
    else if (tool === "laser") local({ op: "laser", ...p });
  });
  el.addEventListener("pointermove", (e) => {
    if (tool === "laser") return local({ op: "laser", ...pos(e) });
    if (tool === "eraser" && e.buttons) return local({ op: "erase", ...pos(e) });
    if (drawing) local({ op: "move", id: drawing.id, ...pos(e) });
  });
  const end = () => {
    if (drawing) onOp({ op: "end", id: drawing.id });
    drawing = null;
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  // A click with a tool never reaches the slide underneath.
  el.addEventListener("click", (e) => tool !== "pointer" && e.stopPropagation());

  const setTool = (t: InkTool) => {
    tool = t;
    el.dataset.tool = t;
    onTool(t);
  };
  el.dataset.tool = tool;

  return {
    el,
    tool: () => tool,
    setTool,
    color: () => color,
    setColor(c) {
      color = c;
    },
    clear() {
      if (strokes.length) local({ op: "clear" });
    },
    apply,
    hasInk: () => strokes.length > 0,
  };
}
