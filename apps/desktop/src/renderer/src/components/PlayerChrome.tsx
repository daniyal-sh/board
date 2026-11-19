import { useEffect, useRef } from "react";
import { Pause, Play } from "./Icons";

/** Shared playback UI for videos and web animations: transport bar, scene filmstrip, keys. */

export interface Segment {
  id: string;
  title: string;
  start: number;
  end: number;
}

export const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function segmentAt(segments: Segment[], t: number): Segment | undefined {
  return segments.find((s) => t >= s.start && t < s.end) ?? segments[segments.length - 1];
}

/** Start of the previous scene (or of this one, if we're more than a moment into it). */
export function prevStart(segments: Segment[], t: number): number {
  const i = segments.findIndex((s) => t >= s.start && t < s.end);
  if (i < 0) return 0;
  if (t - segments[i].start > 1.5 || i === 0) return segments[i].start;
  return segments[i - 1].start;
}

export function nextStart(segments: Segment[], t: number): number | undefined {
  return segments.find((s) => s.start > t + 0.05)?.start;
}

const SkipBack = () => (
  <svg width="12" height="12" viewBox="0 0 12 12">
    <rect x="1.5" y="1.5" width="1.6" height="9" rx=".6" fill="currentColor" />
    <path d="M10.5 1.5v9L4 6z" fill="currentColor" />
  </svg>
);
const SkipFwd = () => (
  <svg width="12" height="12" viewBox="0 0 12 12">
    <rect x="8.9" y="1.5" width="1.6" height="9" rx=".6" fill="currentColor" />
    <path d="M1.5 1.5v9L8 6z" fill="currentColor" />
  </svg>
);

/** Glass transport bar that sits over the bottom of the stage. */
export function Transport(props: {
  playing: boolean;
  time: number;
  duration: number;
  segments: Segment[];
  onToggle: () => void;
  onSeek: (t: number) => void;
}) {
  const { time, duration, segments } = props;
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const many = segments.length > 1;
  const next = nextStart(segments, time);

  function at(clientX: number) {
    const r = bar.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  }

  return (
    <div className="glass absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-[11px] py-1.5 pl-1.5 pr-3" onClick={(e) => e.stopPropagation()}>
      {many && (
        <button className="grid h-7 w-7 place-items-center rounded-[7px] text-white/85 hover:bg-white/15" title="Previous scene" onClick={() => props.onSeek(prevStart(segments, time))}>
          <SkipBack />
        </button>
      )}
      <button className="grid h-7 w-7 place-items-center rounded-[7px] bg-white text-black" title={props.playing ? "Pause (space)" : "Play (space)"} onClick={props.onToggle}>
        {props.playing ? <Pause /> : <Play />}
      </button>
      {many && (
        <button
          className="grid h-7 w-7 place-items-center rounded-[7px] text-white/85 hover:bg-white/15 disabled:opacity-40"
          title="Next scene"
          disabled={next === undefined}
          onClick={() => next !== undefined && props.onSeek(next)}
        >
          <SkipFwd />
        </button>
      )}
      <span className="ml-1 font-mono text-[11px] text-white/85">{fmt(time)}</span>
      <div
        ref={bar}
        className="group relative flex h-4 flex-1 cursor-pointer items-center"
        onPointerDown={(e) => {
          if (!duration) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          props.onSeek(at(e.clientX));
        }}
        onPointerMove={(e) => dragging.current && props.onSeek(at(e.clientX))}
        onPointerUp={() => (dragging.current = false)}
      >
        <div className="relative h-1 w-full rounded bg-white/25">
          <i className="absolute inset-y-0 left-0 rounded bg-white" style={{ width: `${duration ? (time / duration) * 100 : 0}%` }} />
          {duration > 0 &&
            segments.slice(1).map((s) => <span key={s.id} className="absolute -top-1 h-3 w-[2px] rounded bg-white/80" style={{ left: `${(s.start / duration) * 100}%` }} title={s.title} />)}
          <span
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white opacity-0 shadow transition-opacity group-hover:opacity-100"
            style={{ left: `${duration ? (time / duration) * 100 : 0}%` }}
          />
        </div>
      </div>
      <span className="font-mono text-[11px] text-white/85">{fmt(duration)}</span>
    </div>
  );
}

/** One lane of scene thumbnails, each as wide as the scene is long. */
export function Filmstrip(props: { segments: Segment[]; duration: number; currentId?: string; thumbs: Record<string, string | undefined>; onSeek: (t: number) => void }) {
  const { segments, duration } = props;
  return (
    <div className="relative h-[46px] rounded-md bg-surface-2">
      {duration > 0 &&
        segments.map((s, i) => {
          const on = props.currentId === s.id;
          const thumb = props.thumbs[s.id];
          return (
            <button
              key={s.id}
              onClick={() => props.onSeek(s.start + 0.01)}
              title={`${i + 1}. ${s.title} · ${fmt(s.end - s.start)}`}
              className="absolute inset-y-[2px] overflow-hidden rounded-[6px] bg-stage text-left transition-shadow"
              style={{
                left: `${(s.start / duration) * 100}%`,
                width: `calc(${((s.end - s.start) / duration) * 100}% - 3px)`,
                boxShadow: on ? "0 0 0 2px var(--color-accent)" : "inset 0 0 0 1px rgba(0,0,0,.15)",
                // Tile the picture along the scene, like frames on a strip of film.
                backgroundImage: thumb ? `url("${thumb}")` : undefined,
                backgroundSize: "auto 100%",
                backgroundRepeat: "repeat-x",
                backgroundPosition: "left center",
              }}
            >
              <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-0.5 pt-3 text-[10.5px] font-semibold text-white">
                {i + 1}. {s.title}
              </span>
            </button>
          );
        })}
    </div>
  );
}

/** Space plays/pauses, ←/→ step 5 s, [ / ] jump between scenes. Ignored while typing. */
export function usePlayerKeys(enabled: boolean, h: { toggle: () => void; seek: (t: number) => void; time: number; duration: number; segments: Segment[] }) {
  const ref = useRef(h);
  ref.current = h;
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const { toggle, seek, time, duration, segments } = ref.current;
      if (!duration) return;
      if (e.key === " ") toggle();
      else if (e.key === "ArrowLeft") seek(Math.max(0, time - 5));
      else if (e.key === "ArrowRight") seek(Math.min(duration, time + 5));
      else if (e.key === "[") seek(prevStart(segments, time));
      else if (e.key === "]") {
        const n = nextStart(segments, time);
        if (n !== undefined) seek(n);
      } else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** Big play button over the stage before playback starts (the first frame is often empty). */
export function StartOverlay(props: { show: boolean; onPlay: () => void }) {
  if (!props.show) return null;
  return (
    <button className="group absolute inset-0 grid place-items-center" onClick={(e) => (e.stopPropagation(), props.onPlay())} title="Play (space)">
      <span className="grid h-16 w-16 place-items-center rounded-full bg-white/90 text-black shadow-[0_10px_30px_-8px_rgba(0,0,0,.6)] transition group-hover:scale-105">
        <Play size={22} />
      </span>
    </button>
  );
}
