import { useEffect, useState } from "react";
import type { Aspect } from "@studio/shared";

/** Pieces shared by the video and web-animation stages. */

/**
 * The dark frame the picture sits in, sized to the aspect ratio. Its data-agent-* attributes
 * tell the assistant's get_view tool what the teacher is looking at.
 */
export function StageFrame(props: {
  aspect?: Aspect;
  frameRef?: React.RefObject<HTMLDivElement | null>;
  agentView: { project: string; view: string; scene: string; time: number; total: number; playing: boolean };
  children: React.ReactNode;
}) {
  const v = props.agentView;
  return (
    <div className="flex min-h-0 items-center justify-center">
      <div
        ref={props.frameRef}
        className={`group/stage @container relative overflow-hidden rounded-[12px] bg-stage shadow-[0_18px_40px_-20px_rgba(0,0,0,.6)] ${props.aspect === "vertical" ? "h-full max-w-full" : "aspect-video max-h-full w-full"}`}
        style={props.aspect === "vertical" ? { aspectRatio: "9 / 16" } : undefined}
        data-agent-view
        data-project={v.project}
        data-view={v.view}
        data-scene={v.scene}
        data-time={v.time.toFixed(1)}
        data-total-time={v.total.toFixed(1)}
        data-playing={String(v.playing)}
      >
        {props.children}
      </div>
    </div>
  );
}

/** Narration caption over the bottom of the picture. */
export function Caption(props: { text?: string }) {
  if (!props.text) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[5%] flex justify-center px-[8%]">
      <span className="rounded-md bg-black/60 px-3 py-1 text-center text-[clamp(12px,2.3cqw,20px)] leading-snug text-white">{props.text}</span>
    </div>
  );
}

export function FullscreenButton(props: { target: React.RefObject<HTMLElement | null> }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const f = () => setOn(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);
  return (
    <button
      className="glass grid h-7 w-7 place-items-center rounded-lg"
      title={on ? "Exit full screen (Esc)" : "Full screen"}
      onClick={(e) => {
        e.stopPropagation();
        if (document.fullscreenElement) void document.exitFullscreen();
        else void props.target.current?.requestFullscreen();
      }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        {on ? <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" /> : <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />}
      </svg>
    </button>
  );
}

function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** What the preview is doing, in plain words. */
export function StatusNote(props: { working: string | null; builtAt: number | null; failed?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, []);
  if (props.working)
    return (
      <span className="flex min-w-0 items-center gap-2 text-[12px] text-muted">
        <span className="spinner flex-none" />
        <span className="truncate">{props.working}</span>
      </span>
    );
  if (props.failed)
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-bad">
        <i className="block h-[7px] w-[7px] rounded-full bg-bad" /> Needs a fix
      </span>
    );
  if (!props.builtAt) return null;
  return (
    <span className="hidden items-center gap-1.5 whitespace-nowrap text-[12px] text-muted @[560px]/stagebar:flex">
      <i className="block h-[7px] w-[7px] rounded-full bg-good" /> Up to date · {ago(Date.now() - props.builtAt)}
    </span>
  );
}
