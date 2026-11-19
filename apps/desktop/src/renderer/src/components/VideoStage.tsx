import { useEffect, useRef, useState } from "react";
import type { FullPreview, SceneMeta, SceneTimeline, Selection, VideoEnvStatus } from "@studio/shared";
import { errorMessage, studio } from "../lib/api";
import { Pause, Play, Refresh } from "./Icons";

type Box = SceneTimeline["parts"][number]["boxes"][number];

/** The part under a click: boxes are snapshots after each step, so use the latest one at or before t. */
function hitTest(tl: SceneTimeline, t: number, x: number, y: number) {
  let best: { part: SceneTimeline["parts"][number]; box: Box; area: number } | null = null;
  for (const part of tl.parts) {
    const box = [...part.boxes].reverse().find((b) => b.t <= t + 0.05) ?? null;
    if (!box) continue;
    const pad = 0.012;
    if (x < box.x0 - pad || x > box.x1 + pad || y < box.y0 - pad || y > box.y1 + pad) continue;
    const area = Math.max(0.0004, (box.x1 - box.x0) * (box.y1 - box.y0));
    if (!best || area < best.area) best = { part, box, area };
  }
  return best;
}

const CLIP_STYLES: React.CSSProperties[] = [
  { background: "#E3F4F9", color: "#1F6E82", boxShadow: "inset 0 0 0 1px #C7E7F0" },
  { background: "#FFF7D1", color: "#7A6200", boxShadow: "inset 0 0 0 1px #F5E59A" },
  { background: "#E6F4EA", color: "#2F7D4A", boxShadow: "inset 0 0 0 1px #C9E6D2" },
  { background: "#F1EBF6", color: "#6B4B7E", boxShadow: "inset 0 0 0 1px #E0D3EA" },
];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

type Mode = "scene" | "full";

export function VideoStage(props: {
  projectId: string;
  scene?: SceneMeta;
  scenes: SceneMeta[];
  revision: number;
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  /** Whole-video mode: the scene under the playhead changed. */
  onActiveScene?: (sceneId: string) => void;
}) {
  const [env, setEnv] = useState<VideoEnvStatus | null>(null);
  const [mode, setMode] = useState<Mode>("scene");
  const [url, setUrl] = useState<string | null>(null);
  const [tl, setTl] = useState<SceneTimeline | null>(null);
  const [full, setFull] = useState<FullPreview | null>(null);
  const [fullTimelines, setFullTimelines] = useState<Record<string, SceneTimeline>>({});
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [selBox, setSelBox] = useState<Box | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);

  useEffect(() => {
    void studio.video.status().then(setEnv);
    return studio.video.onProgress((m) => setWorking(m));
  }, []);

  // ---------------------------------------------------------------- scene mode
  useEffect(() => {
    if (mode !== "scene") return;
    if (!props.scene) {
      setUrl(null);
      setTl(null);
      return;
    }
    void studio.video.sceneUrl(props.projectId, props.scene.id).then(setUrl);
    void studio.video.timeline(props.projectId, props.scene.id).then(setTl);
    setSelBox(null);
  }, [mode, props.projectId, props.scene?.id, props.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- whole-video mode
  async function loadFull() {
    setWorking("Preparing the whole video…");
    setRenderError(null);
    try {
      const f = await studio.video.fullPreview(props.projectId);
      setFull(f);
      const tls: Record<string, SceneTimeline> = {};
      await Promise.all(
        f.segments.map(async (s) => {
          const t = await studio.video.timeline(props.projectId, s.sceneId);
          if (t) tls[s.sceneId] = t;
        }),
      );
      setFullTimelines(tls);
      if (!f.ok && f.failed.length) setRenderError(f.failed.map((x) => `${x.title || "Video"}: ${x.log}`).join("\n\n"));
    } catch (e) {
      setRenderError(errorMessage(e));
    } finally {
      setWorking(null);
    }
  }

  useEffect(() => {
    if (mode === "full") void loadFull();
  }, [mode, props.projectId, props.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const segments = full?.segments ?? [];
  const segmentAt = (t: number) => segments.find((s) => t >= s.start && t < s.end) ?? segments[segments.length - 1];
  const currentSegment = mode === "full" ? segmentAt(time) : undefined;

  // Picking a scene in the storyboard jumps there in whole-video mode.
  useEffect(() => {
    if (mode !== "full" || !props.scene) return;
    const seg = segments.find((s) => s.sceneId === props.scene!.id);
    if (seg && currentSegment?.sceneId !== seg.sceneId) seek(seg.start + 0.01);
  }, [props.scene?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the storyboard which scene is playing.
  useEffect(() => {
    if (currentSegment && currentSegment.sceneId !== props.scene?.id) props.onActiveScene?.(currentSegment.sceneId);
  }, [currentSegment?.sceneId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!props.selection) setSelBox(null);
  }, [props.selection]);

  async function renderNow() {
    if (!props.scene) return;
    setWorking("Rendering a draft…");
    setRenderError(null);
    try {
      const r = await studio.build.preview(props.projectId, props.scene.id);
      if (!r.ok) setRenderError(r.errors.join("\n"));
      setUrl(await studio.video.sceneUrl(props.projectId, props.scene.id));
      setTl(await studio.video.timeline(props.projectId, props.scene.id));
    } catch (e) {
      setRenderError(errorMessage(e));
    } finally {
      setWorking(null);
    }
  }

  if (env && !env.ready) return <VideoSetup onReady={setEnv} />;

  const src = mode === "full" ? full?.url ?? null : url;
  const duration = mode === "full" ? full?.duration ?? 0 : tl?.duration || video.current?.duration || 0;

  function seek(t: number) {
    if (video.current && video.current.readyState > 0) video.current.currentTime = t;
    else pendingSeek.current = t;
    setTime(t);
  }

  function onStageClick(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    video.current?.pause();
    // In whole-video mode, translate to the scene under the playhead.
    const seg = currentSegment;
    const sceneId = mode === "full" ? seg?.sceneId : props.scene?.id;
    const timeline = mode === "full" ? (sceneId ? fullTimelines[sceneId] : undefined) : tl;
    const local = mode === "full" && seg ? time - seg.start : time;
    const scene = props.scenes.find((s) => s.id === sceneId);
    if (!timeline || !scene) return;
    const hit = hitTest(timeline, local, x, y);
    if (!hit) {
      setSelBox(null);
      props.onSelect(null);
      return;
    }
    setSelBox(hit.box);
    props.onSelect({ part: hit.part.name, kind: hit.part.type, sceneId: scene.id, time: local, source: { file: scene.file, line: hit.part.line ?? undefined } });
  }

  // Timeline rows: scene mode shows that scene's animations; whole mode shows scenes, plus every
  // animation offset into place.
  const plays =
    mode === "full"
      ? segments.flatMap((s) => (fullTimelines[s.sceneId]?.plays ?? []).filter((p) => p.kind === "play").map((p) => ({ ...p, start: p.start + s.start, end: p.end + s.start })))
      : (tl?.plays.filter((p) => p.kind === "play") ?? []);
  const marks =
    mode === "full"
      ? segments.flatMap((s) => (fullTimelines[s.sceneId]?.plays ?? []).filter((p) => p.kind === "mark").map((p) => ({ ...p, end: p.end + s.start })))
      : (tl?.plays.filter((p) => p.kind === "mark") ?? []);

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto] gap-3 px-[18px] py-4">
      <div className="flex items-center gap-2">
        <div className="seg">
          <button data-on={mode === "scene"} onClick={() => setMode("scene")}>
            This scene
          </button>
          <button data-on={mode === "full"} onClick={() => setMode("full")} disabled={!props.scenes.length}>
            Whole video
          </button>
        </div>
        <span className="truncate text-[12px] text-muted">
          {mode === "full"
            ? full?.ok
              ? `${segments.length} scene${segments.length === 1 ? "" : "s"} · ${fmt(full.duration)}${currentSegment ? ` · now: ${currentSegment.title}` : ""}`
              : ""
            : props.scene
              ? props.scene.title
              : ""}
        </span>
        <span className="flex-1" />
        {working && (
          <span className="flex items-center gap-2 text-[12px] text-muted">
            <span className="spinner" /> {working}
          </span>
        )}
        <button
          className="btn btn-ghost btn-sm"
          disabled={Boolean(working) || (mode === "scene" && !props.scene)}
          onClick={() => void (mode === "full" ? loadFull() : renderNow())}
          title={mode === "full" ? "Re-render changed scenes and rebuild" : "Render this scene again"}
        >
          <Refresh size={13} /> {mode === "full" ? "Update" : "Re-render"}
        </button>
      </div>

      <div className="flex min-h-0 items-center justify-center">
        <div className="relative aspect-video max-h-full w-full overflow-hidden rounded-[14px] bg-stage shadow-[0_18px_40px_-20px_rgba(0,0,0,.6)]">
          {src ? (
            <>
              <video
                ref={video}
                key={src}
                src={src}
                className="h-full w-full"
                onLoadedMetadata={(e) => {
                  if (pendingSeek.current !== null) {
                    e.currentTarget.currentTime = pendingSeek.current;
                    pendingSeek.current = null;
                  }
                }}
                onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
              />
              <div className="absolute inset-0 cursor-crosshair" onClick={onStageClick} />
              {selBox && (
                <div
                  className="pointer-events-none absolute rounded-md border-[1.5px] border-manim-yellow"
                  style={{
                    left: `${selBox.x0 * 100}%`,
                    top: `${selBox.y0 * 100}%`,
                    width: `${(selBox.x1 - selBox.x0) * 100}%`,
                    height: `${(selBox.y1 - selBox.y0) * 100}%`,
                    boxShadow: "0 0 0 4px rgba(255,225,77,.15)",
                  }}
                />
              )}
              {mode === "full" && currentSegment && (
                <span className="glass absolute left-3 top-3 rounded-lg px-2.5 py-1 text-[11px]">{currentSegment.title}</span>
              )}
              <span className="glass absolute right-3 top-3 rounded-lg px-2.5 py-1 text-[11px]">Click anything to change it</span>
              <div className="glass absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-[11px] py-1.5 pl-1.5 pr-3">
                <button className="grid h-7 w-7 place-items-center rounded-[7px] bg-white text-black" onClick={() => (playing ? video.current?.pause() : video.current?.play())}>
                  {playing ? <Pause /> : <Play />}
                </button>
                <span className="font-mono text-[11px] text-white/85">{fmt(time)}</span>
                <div
                  className="relative h-1 flex-1 cursor-pointer rounded bg-white/25"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    seek(((e.clientX - r.left) / r.width) * duration);
                  }}
                >
                  <i className="absolute inset-y-0 left-0 rounded bg-white" style={{ width: `${duration ? (time / duration) * 100 : 0}%` }} />
                  {/* Chapter marks between scenes */}
                  {mode === "full" &&
                    duration > 0 &&
                    segments.slice(1).map((s) => <span key={s.sceneId} className="absolute -top-1 h-3 w-[2px] rounded bg-white/80" style={{ left: `${(s.start / duration) * 100}%` }} title={s.title} />)}
                </div>
                <span className="font-mono text-[11px] text-white/85">{fmt(duration)}</span>
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center p-8 text-center text-white/70">
              {mode === "full" ? (
                <div className="flex flex-col items-center gap-3">
                  {working ? (
                    <>
                      <div className="spinner" />
                      <span>{working}</span>
                    </>
                  ) : (
                    <span>No scenes have rendered yet.</span>
                  )}
                </div>
              ) : props.scene ? (
                <div className="flex flex-col items-center gap-3">
                  <span>{working ?? "This scene hasn't been rendered yet."}</span>
                  {working ? <div className="spinner" /> : <button className="btn btn-sm" onClick={() => void renderNow()}>Render draft</button>}
                </div>
              ) : (
                "Scenes appear here once the assistant writes them."
              )}
            </div>
          )}
          {renderError && (
            <div className="absolute inset-x-3 top-3 max-h-[60%] overflow-auto rounded-xl bg-bad-soft p-3 font-mono text-[11.5px] text-bad">
              <b className="mb-1 block font-sans">{mode === "full" ? "Some scenes didn't render (left out of the preview)" : "Render failed"}</b>
              <pre className="whitespace-pre-wrap">{renderError}</pre>
            </div>
          )}
        </div>
      </div>

      <div className="card px-3 pb-3 pt-2.5">
        <div className="mb-2 flex items-center gap-2.5 text-[12px] text-muted">
          <b className="text-[12.5px] font-semibold text-ink">Timeline</b>
          <span>{duration ? "Click a block to jump there" : "Appears after the first render"}</span>
        </div>
        <div className="grid grid-cols-[70px_1fr] gap-x-2.5">
          <div>
            {mode === "full" && <div className="mb-1.5 flex h-6 items-center gap-1.5 text-[11.5px] text-muted"><i className="block h-[7px] w-[7px] rounded-sm bg-ink" />Scenes</div>}
            <div className="mb-1.5 flex h-6 items-center gap-1.5 text-[11.5px] text-muted"><i className="block h-[7px] w-[7px] rounded-sm bg-manim-blue" />Animation</div>
            <div className="flex h-6 items-center gap-1.5 text-[11.5px] text-muted"><i className="block h-[7px] w-[7px] rounded-sm bg-[#E8A33D]" />Voice cues</div>
          </div>
          <div className="relative grid gap-1.5">
            {mode === "full" && (
              <div className="relative h-6 rounded-md bg-surface-2">
                {duration > 0 &&
                  segments.map((s) => (
                    <button
                      key={s.sceneId}
                      onClick={() => seek(s.start + 0.01)}
                      title={s.title}
                      className="absolute inset-y-[2px] overflow-hidden whitespace-nowrap rounded-[5px] px-2 text-left text-[11px] font-semibold"
                      style={{
                        left: `${(s.start / duration) * 100}%`,
                        width: `calc(${((s.end - s.start) / duration) * 100}% - 2px)`,
                        background: currentSegment?.sceneId === s.sceneId ? "var(--color-ink)" : "#EAE7E0",
                        color: currentSegment?.sceneId === s.sceneId ? "#fff" : "var(--color-ink-2)",
                      }}
                    >
                      {s.title}
                    </button>
                  ))}
              </div>
            )}
            <div className="relative h-6 rounded-md bg-surface-2">
              {duration > 0 &&
                plays.map((p, i) => (
                  <button
                    key={i}
                    title={`${p.label} · line ${p.line ?? "?"}`}
                    onClick={() => seek(p.start)}
                    className="absolute inset-y-[2px] overflow-hidden whitespace-nowrap rounded-[5px] px-2 text-left text-[11px] font-medium"
                    style={{ left: `${(p.start / duration) * 100}%`, width: `calc(${((p.end - p.start) / duration) * 100}% - 2px)`, ...CLIP_STYLES[i % 4] }}
                  >
                    {mode === "full" ? "" : p.label}
                  </button>
                ))}
            </div>
            <div className="relative h-6 rounded-md bg-surface-2">
              {duration > 0 && marks.map((m, i) => <span key={i} title={m.label} className="absolute inset-y-[-3px] w-0.5 rounded bg-[#E8A33D]" style={{ left: `${(m.end / duration) * 100}%` }} />)}
              {duration > 0 && marks.length === 0 && <span className="absolute left-2 top-1 text-[11px] text-faint">No narration yet</span>}
            </div>
            {duration > 0 && <span className="pointer-events-none absolute -inset-y-1 w-0.5 rounded bg-ink" style={{ left: `${(time / duration) * 100}%` }} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function VideoSetup(props: { onReady: (s: VideoEnvStatus) => void }) {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => studio.video.onSetupProgress((p) => setLog((l) => [...l.slice(-6), p.message])), []);

  async function go() {
    setRunning(true);
    setError(null);
    try {
      props.onReady(await studio.video.setup());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="grid h-full place-items-center p-8">
      <div className="card max-w-[460px] p-6 animate-in">
        <h2 className="serif m-0 text-[28px]">One-time video setup</h2>
        <p className="mt-1 text-ink-2">
          Videos are rendered on your computer with Manim. Studio will download Python, Manim and LaTeX (about 300 MB) into its own folder. Nothing else on your
          computer changes.
        </p>
        {log.length > 0 && (
          <div className="my-3 max-h-36 overflow-auto rounded-lg bg-surface-2 p-2.5 font-mono text-[11px] text-ink-2">
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
        {error && <div className="my-3 whitespace-pre-wrap rounded-lg bg-bad-soft p-2.5 text-[12px] text-bad">{error}</div>}
        <button className="btn btn-dark mt-2" disabled={running} onClick={() => void go()}>
          {running ? <span className="spinner" /> : null}
          {running ? "Installing…" : error ? "Try again" : "Set up video tools"}
        </button>
      </div>
    </div>
  );
}
