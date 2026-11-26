import { useEffect, useRef, useState } from "react";
import type { Aspect } from "@studio/shared";
import { studio } from "../lib/api";
import type { DeckPosition, DeckSlide } from "./SlidesStage";
import { Next, Prev } from "./Icons";

type Tool = "pointer" | "pen" | "highlighter" | "laser" | "eraser";
const COLORS = ["#FFE14D", "#FC6255", "#58C4DD", "#83C167", "#FFFFFF"];
const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: "pointer", label: "Pointer", key: "Esc" },
  { id: "pen", label: "Pen", key: "P" },
  { id: "highlighter", label: "Highlighter", key: "H" },
  { id: "laser", label: "Laser", key: "L" },
  { id: "eraser", label: "Eraser", key: "E" },
];

/**
 * The presenter view: a live picture of the audience screen (click and draw on it), the next
 * step, the speaker notes, a timer and the tools. Everything is sent to the audience window,
 * which is the only place the slides run.
 */
export function Presenter(props: { projectId: string; title: string; aspect?: Aspect; slides: DeckSlide[]; external: boolean; onEnd: () => void }) {
  const [frame, setFrame] = useState<string | null>(null);
  const [pos, setPos] = useState<DeckPosition | null>(null);
  const [slides, setSlides] = useState<DeckSlide[]>(props.slides);
  const [tool, setToolState] = useState<Tool>("pointer");
  const [color, setColor] = useState(COLORS[0]);
  const [blank, setBlank] = useState(false);
  const [started, setStarted] = useState(Date.now());
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [, tick] = useState(0);
  const next = useRef<HTMLIFrameElement>(null);
  const [nextReady, setNextReady] = useState(false);
  const nextUrl = useRef(`studio-preview://${props.projectId}/deck.html?v=${Date.now()}&follower=1&still=1`);

  useEffect(() => {
    const offs = [
      studio.present.onFrame(setFrame),
      studio.present.onState((s) => setPos(s)),
      studio.present.onReady((d) => setSlides(d.slides)),
      studio.present.onEnded(() => props.onEnd()),
    ];
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => {
      offs.forEach((f) => f());
      clearInterval(t);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cmd = (c: Record<string, unknown>) => void studio.present.command(c);
  const setTool = (t: Tool) => {
    setToolState(t);
    cmd({ cmd: "tool", tool: t, color });
  };

  // The next step: the next step of this slide, or the first step of the next one.
  const cur = pos ? slides[pos.index] : undefined;
  const after = pos && cur ? (pos.step + 1 < cur.steps ? { i: pos.index, k: pos.step + 1 } : { i: pos.index + 1, k: 0 }) : null;
  const nextSlide = after ? slides[after.i] : undefined;
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source === next.current?.contentWindow && e.data?.__studio && e.data.type === "deck.follower") setNextReady(true);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  useEffect(() => {
    if (nextReady && nextSlide && after) next.current?.contentWindow?.postMessage({ __studio: 1, type: "deck", cmd: "goto", slide: nextSlide.id, step: after.k, play: false }, "*");
  }, [nextReady, nextSlide?.id, after?.k]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keys: the same as in the deck.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === "ArrowRight" || k === "ArrowDown" || k === " " || k === "PageDown" || k === "Enter" || k === "n") cmd({ cmd: "next" });
      else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace") cmd({ cmd: "prev" });
      else if (k === "b" || k === ".") toggleBlank();
      else if (k === "p") setTool(tool === "pen" ? "pointer" : "pen");
      else if (k === "h") setTool(tool === "highlighter" ? "pointer" : "highlighter");
      else if (k === "l") setTool(tool === "laser" ? "pointer" : "laser");
      else if (k === "e") setTool(tool === "eraser" ? "pointer" : "eraser");
      else if (k === "c") cmd({ cmd: "clear" });
      else if (k === "Escape") {
        if (tool !== "pointer") setTool("pointer");
        else void studio.present.stop();
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleBlank = () => {
    setBlank((b) => {
      cmd({ cmd: "blank", value: !b });
      return !b;
    });
  };

  // Pointer on the live picture goes to the audience window.
  const lastMove = useRef(0);
  const at = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const elapsed = (pausedAt ?? Date.now()) - started;
  const mm = Math.floor(elapsed / 60000);
  const ss = Math.floor((elapsed % 60000) / 1000);
  const vertical = props.aspect === "vertical";

  return (
    <div className="fixed inset-0 z-50 grid grid-rows-[auto_minmax(0,1fr)] bg-[#0b0b0f] text-[#ecebe6]" role="dialog" aria-label="Presenter view">
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5">
        <span className="font-mono text-[24px] font-semibold tabular-nums text-[#ffe14d]" title="Time since you started">
          {mm}:{String(ss).padStart(2, "0")}
        </span>
        <button
          className="rounded-lg bg-white/10 px-2.5 py-1 text-[12.5px] hover:bg-white/15"
          onClick={() => {
            if (pausedAt) {
              setStarted((s) => s + Date.now() - pausedAt);
              setPausedAt(null);
            } else setPausedAt(Date.now());
          }}
        >
          {pausedAt ? "Resume" : "Pause"}
        </button>
        <button className="rounded-lg bg-white/10 px-2.5 py-1 text-[12.5px] hover:bg-white/15" onClick={() => (setStarted(Date.now()), pausedAt && setPausedAt(Date.now()))}>
          Reset
        </button>
        <span className="text-[13px] text-white/55 tabular-nums">{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <span className="mx-2 h-5 w-px bg-white/15" />
        <div className="flex items-center gap-1" role="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              aria-pressed={tool === t.id}
              title={`${t.label} (${t.key})`}
              onClick={() => setTool(t.id)}
              className={`rounded-lg px-2.5 py-1 text-[12.5px] ${tool === t.id ? "bg-[#ffe14d] font-semibold text-black" : "bg-white/10 hover:bg-white/15"}`}
            >
              {t.label}
            </button>
          ))}
          <span className="ml-1 flex items-center gap-1">
            {COLORS.map((c) => (
              <button
                key={c}
                title="Ink colour"
                aria-pressed={color === c}
                onClick={() => {
                  setColor(c);
                  const t = tool === "pen" || tool === "highlighter" ? tool : "pen";
                  setToolState(t);
                  cmd({ cmd: "tool", tool: t, color: c });
                }}
                className="h-[18px] w-[18px] rounded-full border-2"
                style={{ background: c, borderColor: color === c ? "#fff" : "transparent" }}
              />
            ))}
          </span>
          <button className="ml-1 rounded-lg bg-white/10 px-2.5 py-1 text-[12.5px] hover:bg-white/15" title="Clear the ink (C)" onClick={() => cmd({ cmd: "clear" })}>
            Clear ink
          </button>
          <button
            className={`rounded-lg px-2.5 py-1 text-[12.5px] ${blank ? "bg-white font-semibold text-black" : "bg-white/10 hover:bg-white/15"}`}
            title="Black screen (B)"
            onClick={toggleBlank}
          >
            Black screen
          </button>
        </div>
        <span className="flex-1" />
        <span className="text-[13px] tabular-nums text-white/70">{pos ? `Slide ${pos.index + 1} / ${slides.length} · step ${pos.step + 1} / ${pos.steps}` : "Starting…"}</span>
        <button className="grid h-8 w-8 place-items-center rounded-lg bg-white/10 hover:bg-white/15" title="Back (←)" onClick={() => cmd({ cmd: "prev" })}>
          <Prev size={16} />
        </button>
        <button className="grid h-8 w-8 place-items-center rounded-lg bg-[#ffe14d] text-black hover:brightness-95" title="Next (→ or Space)" onClick={() => cmd({ cmd: "next" })}>
          <Next size={16} />
        </button>
        <button className="ml-1 rounded-lg bg-[#fc6255] px-3 py-1 text-[12.5px] font-semibold text-black" onClick={() => void studio.present.stop()} title="End the presentation (Esc)">
          End
        </button>
      </div>

      <div className="grid min-h-0 gap-4 p-4" style={{ gridTemplateColumns: vertical ? "minmax(0,1fr) minmax(0,1.2fr)" : "minmax(0,1.75fr) minmax(0,1fr)" }}>
        <div className="flex min-h-0 flex-col gap-2">
          <span className="text-[11.5px] uppercase tracking-[0.08em] text-white/45">{props.external ? "On the screen" : "On the screen (this display)"}</span>
          <div className="flex min-h-0 flex-1 items-start justify-center">
            <div
              className={`relative overflow-hidden rounded-[10px] border border-white/10 bg-black ${vertical ? "h-full" : "w-full"}`}
              style={{ aspectRatio: vertical ? "9 / 16" : "16 / 9", cursor: tool === "pointer" ? "default" : tool === "laser" ? "none" : "crosshair", touchAction: "none" }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                void studio.present.input({ type: "down", ...at(e) });
              }}
              onPointerMove={(e) => {
                const now = performance.now();
                if (now - lastMove.current < 16) return;
                lastMove.current = now;
                void studio.present.input({ type: "move", ...at(e), buttons: e.buttons });
              }}
              onPointerUp={(e) => void studio.present.input({ type: "up", ...at(e) })}
            >
              {frame ? <img src={frame} alt="The audience screen" className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain" draggable={false} /> : <div className="grid h-full place-items-center text-white/50">Opening the slides…</div>}
            </div>
          </div>
          <span className="truncate text-[15px] font-semibold">{cur?.title ?? ""}</span>
        </div>
        <div className="flex min-h-0 flex-col gap-2">
          <span className="text-[11.5px] uppercase tracking-[0.08em] text-white/45">Next</span>
          <div className="relative overflow-hidden rounded-[10px] border border-white/10 bg-black" style={{ aspectRatio: vertical ? "9 / 16" : "16 / 9", maxHeight: "42%" }}>
            <iframe ref={next} src={nextUrl.current} title="Next step" sandbox="allow-scripts" className="pointer-events-none absolute inset-0 h-full w-full border-0" />
            {pos && !nextSlide && <div className="absolute inset-0 grid place-items-center bg-black text-white/55">End of the slides</div>}
          </div>
          <span className="truncate text-[13px] text-white/60">{nextSlide ? (after && after.i === pos?.index ? `Step ${after.k + 1} of “${nextSlide.title}”` : `Slide ${after!.i + 1}: ${nextSlide.title}`) : ""}</span>
          <span className="mt-1 text-[11.5px] uppercase tracking-[0.08em] text-white/45">Notes</span>
          <div className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-[10px] border border-white/10 bg-white/[0.04] px-4 py-3 text-[19px] leading-relaxed">
            {cur?.notes ? cur.notes : <span className="text-white/35">No notes for this slide.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
