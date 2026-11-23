import { useEffect, useRef, useState } from "react";
import type { Aspect, SceneMeta, Selection } from "@studio/shared";
import { errorMessage, studio } from "../lib/api";
import { segmentAt, usePlayer, type Cue, type PlayerBus, type Segment, type Step } from "../lib/player";
import { Cursor, Refresh } from "./Icons";
import { StartOverlay } from "./Timeline";
import { FullscreenButton, StageFrame, StatusNote } from "./StageParts";

interface ConsoleLine {
  level: string;
  text: string;
}

/**
 * Web animations. The preview records every scene into one manim-web Player timeline; this
 * component drives it from outside through the shared player (play, pause, scrub, speed,
 * captions) and passes on its scenes, steps and cues for the timeline.
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
  bus: PlayerBus;
  leading?: React.ReactNode;
}) {
  const { bus } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const frameBox = useRef<HTMLDivElement>(null);
  const [whole, setWhole] = useState(true);
  const [url, setUrl] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [building, setBuilding] = useState(false);
  const [builtAt, setBuiltAt] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const time = usePlayer(bus, (s) => s.time);
  const playing = usePlayer(bus, (s) => s.playing);
  const duration = usePlayer(bus, (s) => s.duration);
  const segments = usePlayer(bus, (s) => s.segments);
  const thumbsFor = useRef(-1);
  const builds = useRef(0);

  useEffect(() => {
    if (!whole && !props.scene) setWhole(true);
  }, [whole, props.scene]);

  async function build() {
    const mine = ++builds.current;
    setBuilding(true);
    try {
      const r = await studio.build.preview(props.projectId);
      if (mine !== builds.current) return;
      setErrors(r.errors);
      if (r.ok && r.previewUrl) {
        setConsoleLines([]);
        bus.set({ ready: false, segments: [], steps: [], cues: [], duration: 0, time: 0, playing: false, view: whole ? "whole" : "scene" });
        const only = !whole && props.scene ? `&scene=${encodeURIComponent(props.scene.id)}&only=1` : "";
        setUrl(r.previewUrl + only);
        setBuiltAt(Date.now());
      }
    } catch (e) {
      if (mine === builds.current) setErrors([errorMessage(e)]);
    } finally {
      if (mine === builds.current) setBuilding(false);
    }
  }

  useEffect(() => {
    void build();
  }, [props.projectId, props.revision, whole, whole ? null : props.scene?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function send(cmd: string, extra: Record<string, unknown> = {}) {
    frame.current?.contentWindow?.postMessage({ __studio: 1, type: "player", cmd, ...extra }, "*");
  }

  useEffect(
    () =>
      bus.attach({
        play: () => send("play"),
        pause: () => send("pause"),
        seek: (t) => send("seek", { time: t }),
        setRate: (r) => send("rate", { value: r }),
        setCaptions: (on) => send("captions", { value: on }),
      }),
    [bus],
  );

  // Messages from the preview: player state, console, picks.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== frame.current?.contentWindow || !e.data?.__studio) return;
      const d = e.data as Record<string, unknown> & { type: string };
      if (d.type === "player.ready") {
        const scenes = (d.scenes as Segment[]) ?? [];
        const steps = ((d.steps as { start: number; end: number; scene: string; label: string }[]) ?? []).map<Step>((s) => ({
          start: s.start,
          end: s.end,
          label: s.label,
          sceneId: s.scene,
        }));
        const cues = ((d.cues as { scene: string; name: string; t: number }[]) ?? []).map<Cue>((c) => ({ t: c.t, name: c.name, sceneId: c.scene }));
        bus.set({ ready: true, segments: scenes, steps, cues, duration: Number(d.duration) || 0, view: whole ? "whole" : "scene" });
        // Re-apply speed and captions to the fresh preview.
        const s = bus.get();
        send("rate", { value: s.rate });
        send("captions", { value: s.captions });
        maybeThumbnails(scenes);
      } else if (d.type === "player.state") {
        bus.set({ time: Number(d.time) || 0, duration: Number(d.duration) || 0, playing: Boolean(d.playing) });
        const s = bus.get();
        if (!d.playing && s.loop && !s.recording && Number(d.time) >= s.duration - 0.05 && s.duration > 0) {
          const seg = segmentAt(s.segments, s.duration - 0.1);
          bus.seek(seg?.start ?? 0);
          bus.play();
        }
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
    if (seg && current?.id !== seg.id) bus.seek(seg.start + 0.01);
  }, [props.scene?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const errorCount = consoleLines.filter((l) => l.level === "error").length;

  return (
    <div className="grid h-full min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-2.5 overflow-hidden px-4 pb-3 pt-3">
      <div className="@container/stagebar flex min-w-0 items-center gap-2">
        {props.leading}
        <div className="seg flex-none">
          <button data-on={whole} onClick={() => setWhole(true)}>
            Whole animation
          </button>
          <button data-on={!whole} onClick={() => setWhole(false)} disabled={!props.scene}>
            This scene
          </button>
        </div>
        <button
          className="btn btn-sm flex-none"
          style={picking ? { background: "var(--color-accent-soft)", borderColor: "var(--color-accent)", color: "var(--color-accent-ink)" } : undefined}
          onClick={() => setPicking((v) => !v)}
          title="Click a part of the animation to change it"
        >
          <Cursor size={14} /> {picking ? "Click a part…" : "Select"}
        </button>
        {props.selection && (
          <span className="chip flex min-w-0 items-center gap-1.5 bg-[#FFF7D1] text-[#7A6200] dark:bg-[#3a3214] dark:text-[#ffe14d]">
            <span className="truncate">{props.selection.part}</span>
            <button onClick={() => props.onSelect(null)} className="opacity-60 hover:opacity-100" aria-label="Clear selection">
              ✕
            </button>
          </span>
        )}
        <span className="flex-1" />
        <StatusNote working={building ? "Building the preview…" : null} builtAt={builtAt} failed={errors.length > 0} />
        {consoleLines.length > 0 && (
          <button
            className="tag flex-none"
            style={errorCount ? { background: "var(--color-bad-soft)", color: "var(--color-bad)" } : { background: "var(--color-warn-soft)", color: "var(--color-warn)" }}
            onClick={() => setShowConsole((v) => !v)}
          >
            {errorCount ? `${errorCount} error${errorCount > 1 ? "s" : ""}` : `${consoleLines.length} warning${consoleLines.length > 1 ? "s" : ""}`}
          </button>
        )}
        <button className="icon-btn flex-none" title="Rebuild the preview" onClick={() => void build()} disabled={building}>
          <Refresh size={15} />
        </button>
      </div>

      <StageFrame
        aspect={props.aspect}
        frameRef={frameBox}
        agentView={{
          project: props.projectId,
          view: whole ? "whole animation" : "one scene",
          scene: (whole ? current?.title : props.scene?.title) ?? "",
          time: whole && current ? time - current.start : time,
          total: time,
          playing,
        }}
      >
        {url ? (
          <iframe ref={frame} key={url} src={url} title="Preview" sandbox="allow-scripts allow-pointer-lock" className="h-full w-full border-0" />
        ) : (
          <div className="grid h-full place-items-center p-8 text-center text-white/70">
            {props.busy || building ? (
              <div className="flex flex-col items-center gap-3">
                <div className="spinner" />
                <span>{props.busy ? "The assistant is building your animation…" : "Building the preview…"}</span>
              </div>
            ) : errors.length ? null : (
              "Scenes appear here once the assistant writes them."
            )}
          </div>
        )}
        {url && (
          <div className="absolute right-2.5 top-2.5 opacity-0 transition-opacity group-hover/stage:opacity-100">
            <FullscreenButton target={frameBox} />
          </div>
        )}
        <StartOverlay show={Boolean(url) && duration > 0 && !playing && time < 0.05 && !picking} onPlay={() => bus.play()} />
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
      </StageFrame>
    </div>
  );
}
