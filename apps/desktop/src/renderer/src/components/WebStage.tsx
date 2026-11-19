import { useEffect, useRef, useState } from "react";
import type { Aspect, SceneMeta, Selection } from "@studio/shared";
import { errorMessage, formatBytes, studio } from "../lib/api";
import { Cursor, Download, Refresh } from "./Icons";
import { Filmstrip, fmt, segmentAt, StartOverlay, Transport, usePlayerKeys, type Segment } from "./PlayerChrome";

interface ConsoleLine {
  level: string;
  text: string;
}

/**
 * Web animations. The preview records every scene into one manim-web Player timeline; this
 * component drives it from outside (play, pause, scrub, jump scene to scene) and shows the
 * scenes as a filmstrip, the same way the video stage does.
 */
export function WebStage(props: {
  projectId: string;
  revision: number;
  busy: boolean;
  scene?: SceneMeta;
  scenes: SceneMeta[];
  selection: Selection | null;
  onSelect: (part: string | null, info?: { tag?: string; text?: string }) => void;
  aspect?: Aspect;
  /** The scene under the playhead changed (whole-animation mode). */
  onActiveScene?: (sceneId: string) => void;
  /** New scene pictures were saved. */
  onThumbnails?: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [whole, setWhole] = useState(true);
  const [url, setUrl] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [size, setSize] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  const [picking, setPicking] = useState(false);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [steps, setSteps] = useState<{ start: number; end: number; wait: boolean }[]>([]);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const thumbsFor = useRef(-1);

  async function build() {
    setBuilding(true);
    try {
      const r = await studio.build.preview(props.projectId);
      setErrors(r.errors);
      if (r.ok && r.previewUrl) {
        setConsoleLines([]);
        setSegments([]);
        setSteps([]);
        setDuration(0);
        setTime(0);
        setPlaying(false);
        const only = !whole && props.scene ? `&scene=${encodeURIComponent(props.scene.id)}&only=1` : "";
        setUrl(r.previewUrl + only);
        setSize(r.sizeBytes ?? null);
      }
    } catch (e) {
      setErrors([errorMessage(e)]);
    } finally {
      setBuilding(false);
    }
  }

  useEffect(() => {
    void build();
  }, [props.projectId, props.revision, whole, whole ? null : props.scene?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function send(cmd: "play" | "pause" | "toggle" | "seek", t?: number) {
    frame.current?.contentWindow?.postMessage({ __studio: 1, type: "player", cmd, time: t }, "*");
  }
  const seek = (t: number) => {
    setTime(t);
    send("seek", t);
  };
  const toggle = () => send("toggle");

  // Messages from the preview: player state, console, picks.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== frame.current?.contentWindow || !e.data?.__studio) return;
      const d = e.data as Record<string, unknown> & { type: string };
      if (d.type === "player.ready") {
        setSegments(d.scenes as Segment[]);
        setSteps(d.segments as typeof steps);
        setDuration(Number(d.duration) || 0);
        maybeThumbnails(d.scenes as Segment[]);
      } else if (d.type === "player.state") {
        setTime(Number(d.time) || 0);
        setDuration(Number(d.duration) || 0);
        setPlaying(Boolean(d.playing));
      } else if (d.type === "console" && (d.level === "error" || d.level === "warn")) {
        const line = { level: String(d.level), text: String(d.text ?? "") };
        setConsoleLines((ls) => (ls.some((l) => l.text === line.text) ? ls : [...ls, line].slice(-50)));
      } else if (d.type === "select" && d.part) {
        send("pause");
        props.onSelect(String(d.part), { tag: d.tag as string | undefined, text: d.text as string | undefined });
        setPicking(false);
      } else if (d.type === "ready") {
        postPick(picking);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  /** Pictures for the storyboard and filmstrip: once per build, only for the whole animation. */
  function maybeThumbnails(scenes: Segment[]) {
    if (!whole || !scenes.length || thumbsFor.current === props.revision) return;
    thumbsFor.current = props.revision;
    void studio.build
      .thumbnails(props.projectId)
      .then(() => props.onThumbnails?.())
      .catch(() => {});
  }

  function postPick(on: boolean) {
    frame.current?.contentWindow?.postMessage({ __studio: 1, type: "pick", on }, "*");
  }
  useEffect(() => postPick(picking), [picking]);

  const current = segmentAt(segments, time);
  useEffect(() => {
    if (whole && current && current.id !== props.scene?.id) props.onActiveScene?.(current.id);
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Picking a scene in the storyboard jumps there.
  useEffect(() => {
    if (!whole || !props.scene) return;
    const seg = segments.find((s) => s.id === props.scene!.id);
    if (seg && current?.id !== seg.id) seek(seg.start + 0.01);
  }, [props.scene?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  usePlayerKeys(duration > 0, { toggle, seek, time, duration, segments });

  const thumbs = Object.fromEntries(props.scenes.map((s) => [s.id, s.thumbUrl]));
  const errorCount = consoleLines.filter((l) => l.level === "error").length;
  const animSteps = steps.filter((s) => !s.wait);

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto] gap-3 px-[18px] py-4">
      <div className="flex items-center gap-2">
        <div className="seg">
          <button data-on={!whole} onClick={() => setWhole(false)} disabled={!props.scene}>
            This scene
          </button>
          <button data-on={whole} onClick={() => setWhole(true)}>
            Whole animation
          </button>
        </div>
        <button
          className="btn btn-sm"
          style={picking ? { background: "var(--color-accent)", color: "#fff" } : undefined}
          onClick={() => setPicking((v) => !v)}
          title="Click a part of the animation to change it"
        >
          <Cursor size={14} /> {picking ? "Click a part…" : "Select"}
        </button>
        {props.selection && (
          <span className="chip flex items-center gap-1.5 bg-[#FFF7D1] text-[#7A6200]">
            {props.selection.part}
            <button onClick={() => props.onSelect(null)} className="opacity-60 hover:opacity-100">
              ✕
            </button>
          </span>
        )}
        <span className="truncate text-[12px] text-muted">
          {whole ? (segments.length ? `${segments.length} scene${segments.length === 1 ? "" : "s"} · ${fmt(duration)}` : "") : props.scene?.title}
        </span>
        <span className="flex-1" />
        {building && <span className="spinner" />}
        {consoleLines.length > 0 && (
          <button className="rounded-full bg-bad-soft px-2.5 py-0.5 text-[12px] font-medium text-bad" onClick={() => setShowConsole((v) => !v)}>
            {errorCount ? `${errorCount} error${errorCount > 1 ? "s" : ""}` : `${consoleLines.length} warning${consoleLines.length > 1 ? "s" : ""}`}
          </button>
        )}
        <button className="icon-btn" title="Rebuild preview" onClick={() => void build()}>
          <Refresh size={15} />
        </button>
      </div>

      <div className="flex min-h-0 items-center justify-center">
        <div
          className={`relative overflow-hidden rounded-[14px] bg-stage shadow-[0_18px_40px_-20px_rgba(0,0,0,.6)] ${props.aspect === "vertical" ? "h-full max-w-full" : "aspect-video max-h-full w-full"}`}
          style={props.aspect === "vertical" ? { aspectRatio: "9 / 16" } : undefined}
          data-agent-view
          data-project={props.projectId}
          data-view={whole ? "whole animation" : "one scene"}
          data-scene={(whole ? current?.title : props.scene?.title) ?? ""}
          data-time={whole && current ? (time - current.start).toFixed(1) : time.toFixed(1)}
          data-total-time={time.toFixed(1)}
          data-playing={String(playing)}
        >
          {url ? (
            <iframe ref={frame} key={url} src={url} title="Preview" sandbox="allow-scripts allow-pointer-lock" className="h-full w-full border-0" />
          ) : (
            <div className="grid h-full place-items-center p-8 text-center text-white/70">
              {props.busy || building ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="spinner" />
                  <span>The assistant is building your animation…</span>
                </div>
              ) : errors.length ? null : (
                "Scenes appear here once the assistant writes them."
              )}
            </div>
          )}
          {whole && current && segments.length > 1 && <span className="glass pointer-events-none absolute left-3 top-3 rounded-lg px-2.5 py-1 text-[11px]">{current.title}</span>}
          <StartOverlay show={Boolean(url) && duration > 0 && !playing && time < 0.05 && !picking} onPlay={() => send("play")} />
          {url && duration > 0 && <Transport playing={playing} time={time} duration={duration} segments={whole ? segments : []} onToggle={toggle} onSeek={seek} />}
          {errors.length > 0 && (
            <div className="absolute inset-x-3 top-3 max-h-[60%] overflow-auto rounded-xl bg-bad-soft p-3 font-mono text-[11.5px] text-bad shadow-1 animate-in">
              <b className="mb-1 block font-sans text-[12.5px]">The preview could not be built</b>
              {errors.map((e, i) => (
                <div key={i} className="whitespace-pre-wrap">
                  {e}
                </div>
              ))}
              <div className="mt-2 font-sans text-[12px] text-ink-2">Ask the assistant to fix it. It sees the same errors.</div>
            </div>
          )}
          {showConsole && (
            <div className="absolute inset-x-3 top-3 max-h-40 overflow-auto rounded-lg bg-surface p-2 font-mono text-[11px] text-ink-2 shadow-1">
              {consoleLines.map((l, i) => (
                <div key={i} className={l.level === "error" ? "text-bad" : "text-warn"}>
                  [{l.level}] {l.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card px-3 pb-3 pt-2.5">
        <div className="mb-2 flex items-center gap-2.5 text-[12px] text-muted">
          <b className="text-[12.5px] font-semibold text-ink">Timeline</b>
          <span className="truncate">{duration ? "Click to jump · space plays, [ ] jumps scenes" : "Appears once the animation builds"}</span>
          <span className="flex-1" />
          {size !== null && <span className="font-mono">one file · {formatBytes(size)}</span>}
          <button className="btn btn-ghost btn-sm" onClick={() => void studio.build.exportHtml(props.projectId)}>
            <Download size={14} /> .html
          </button>
        </div>
        <div className="grid grid-cols-[70px_1fr] gap-x-2.5">
          <div>
            {whole && <div className="mb-1.5 flex h-[46px] items-center gap-1.5 text-[11.5px] text-muted"><i className="block h-[7px] w-[7px] rounded-sm bg-ink" />Scenes</div>}
            <div className="flex h-6 items-center gap-1.5 text-[11.5px] text-muted"><i className="block h-[7px] w-[7px] rounded-sm bg-manim-blue" />Animation</div>
          </div>
          <div className="relative grid gap-1.5">
            {whole && <Filmstrip segments={segments} duration={duration} currentId={current?.id} thumbs={thumbs} onSeek={seek} />}
            <div
              className="relative h-6 cursor-pointer rounded-md bg-surface-2"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                if (duration) seek(((e.clientX - r.left) / r.width) * duration);
              }}
            >
              {duration > 0 &&
                animSteps.map((s, i) => (
                  <span
                    key={i}
                    className="absolute inset-y-[3px] rounded-[4px] border border-context/30 bg-context-soft"
                    style={{ left: `${(s.start / duration) * 100}%`, width: `max(2px, calc(${((s.end - s.start) / duration) * 100}% - 1px))` }}
                  />
                ))}
            </div>
            {duration > 0 && <span className="pointer-events-none absolute -inset-y-1 w-0.5 rounded bg-ink" style={{ left: `${(time / duration) * 100}%` }} />}
          </div>
        </div>
      </div>
    </div>
  );
}
