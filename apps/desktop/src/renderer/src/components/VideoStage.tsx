import { useEffect, useRef, useState } from "react";
import type { SceneMeta, SceneTimeline, Selection, VideoEnvStatus } from "@studio/shared";
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

const CLIP_COLORS = ["c-blue", "c-yel", "c-grn", "c-vio"];
const CLIP_STYLE: Record<string, React.CSSProperties> = {
  "c-blue": { background: "#E3F4F9", color: "#1F6E82", boxShadow: "inset 0 0 0 1px #C7E7F0" },
  "c-yel": { background: "#FFF7D1", color: "#7A6200", boxShadow: "inset 0 0 0 1px #F5E59A" },
  "c-grn": { background: "#E6F4EA", color: "#2F7D4A", boxShadow: "inset 0 0 0 1px #C9E6D2" },
  "c-vio": { background: "#F1EBF6", color: "#6B4B7E", boxShadow: "inset 0 0 0 1px #E0D3EA" },
};

export function VideoStage(props: {
  projectId: string;
  scene?: SceneMeta;
  revision: number;
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
}) {
  const [env, setEnv] = useState<VideoEnvStatus | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [tl, setTl] = useState<SceneTimeline | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [selBox, setSelBox] = useState<Box | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    void studio.video.status().then(setEnv);
  }, []);

  useEffect(() => {
    if (!props.scene) {
      setUrl(null);
      setTl(null);
      return;
    }
    void studio.video.sceneUrl(props.projectId, props.scene.id).then(setUrl);
    void studio.video.timeline(props.projectId, props.scene.id).then(setTl);
    setSelBox(null);
  }, [props.projectId, props.scene?.id, props.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!props.selection) setSelBox(null);
  }, [props.selection]);

  async function renderNow() {
    if (!props.scene) return;
    setRendering(true);
    setRenderError(null);
    try {
      const r = await studio.build.preview(props.projectId, props.scene.id);
      if (!r.ok) setRenderError(r.errors.join("\n"));
      setUrl(await studio.video.sceneUrl(props.projectId, props.scene.id));
      setTl(await studio.video.timeline(props.projectId, props.scene.id));
    } catch (e) {
      setRenderError(errorMessage(e));
    } finally {
      setRendering(false);
    }
  }

  if (env && !env.ready) return <VideoSetup onReady={setEnv} />;

  const duration = tl?.duration || video.current?.duration || 0;
  const plays = tl?.plays.filter((p) => p.kind === "play") ?? [];
  const marks = tl?.plays.filter((p) => p.kind === "mark") ?? [];

  function seek(t: number) {
    if (video.current) video.current.currentTime = t;
    setTime(t);
  }

  function onStageClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!tl || !props.scene) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    video.current?.pause();
    const hit = hitTest(tl, time, x, y);
    if (!hit) {
      setSelBox(null);
      props.onSelect(null);
      return;
    }
    setSelBox(hit.box);
    props.onSelect({
      part: hit.part.name,
      kind: hit.part.type,
      sceneId: props.scene.id,
      time,
      source: { file: props.scene.file, line: hit.part.line ?? undefined },
    });
  }

  return (
    <div className="grid h-full grid-rows-[minmax(0,1fr)_auto] gap-3.5 px-[18px] py-4">
      <div className="flex min-h-0 items-center justify-center">
        <div className="relative aspect-video max-h-full w-full overflow-hidden rounded-[14px] bg-stage shadow-[0_18px_40px_-20px_rgba(0,0,0,.6)]">
          {url ? (
            <>
              <video
                ref={video}
                key={url}
                src={url}
                className="h-full w-full"
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
              <span className="glass absolute right-3 top-3 rounded-lg px-2.5 py-1 text-[11px]">{tl ? "Click anything to change it" : "Draft"}</span>
              <div className="glass absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-[11px] py-1.5 pl-1.5 pr-3">
                <button className="grid h-7 w-7 place-items-center rounded-[7px] bg-white text-black" onClick={() => (playing ? video.current?.pause() : video.current?.play())}>
                  {playing ? <Pause /> : <Play />}
                </button>
                <span className="font-mono text-[11px] text-white/85">{time.toFixed(1)}s</span>
                <div
                  className="relative h-1 flex-1 cursor-pointer rounded bg-white/25"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    seek(((e.clientX - r.left) / r.width) * duration);
                  }}
                >
                  <i className="absolute inset-y-0 left-0 rounded bg-white" style={{ width: `${duration ? (time / duration) * 100 : 0}%` }} />
                </div>
                <span className="font-mono text-[11px] text-white/85">{duration.toFixed(1)}s</span>
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center p-8 text-center text-white/70">
              {props.scene ? (
                <div className="flex flex-col items-center gap-3">
                  <span>{rendering ? "Rendering a draft…" : "This scene hasn't been rendered yet."}</span>
                  {rendering ? <div className="spinner" /> : <button className="btn btn-sm" onClick={() => void renderNow()}>Render draft</button>}
                </div>
              ) : (
                "Scenes appear here once the assistant writes them."
              )}
            </div>
          )}
          {renderError && (
            <div className="absolute inset-x-3 top-3 max-h-[60%] overflow-auto rounded-xl bg-bad-soft p-3 font-mono text-[11.5px] text-bad">
              <b className="mb-1 block font-sans">Render failed</b>
              <pre className="whitespace-pre-wrap">{renderError}</pre>
            </div>
          )}
        </div>
      </div>

      <div className="card px-3 pb-3 pt-2.5">
        <div className="mb-2 flex items-center gap-2.5 text-[12px] text-muted">
          <b className="text-[12.5px] font-semibold text-ink">Timeline</b>
          <span>{tl ? "Click a block to jump there" : "Appears after the first render"}</span>
          <span className="flex-1" />
          {props.scene && (
            <button className="btn btn-ghost btn-sm" disabled={rendering} onClick={() => void renderNow()}>
              <Refresh size={13} /> Re-render
            </button>
          )}
        </div>
        <div className="grid grid-cols-[70px_1fr] gap-x-2.5">
          <div>
            <div className="mb-1.5 flex h-6 items-center gap-1.5 text-[11.5px] text-muted"><i className="block h-[7px] w-[7px] rounded-sm bg-manim-blue" />Animation</div>
            <div className="flex h-6 items-center gap-1.5 text-[11.5px] text-muted"><i className="block h-[7px] w-[7px] rounded-sm bg-[#E8A33D]" />Voice cues</div>
          </div>
          <div className="relative grid gap-1.5">
            <div className="relative h-6 rounded-md bg-surface-2">
              {duration > 0 &&
                plays.map((p, i) => (
                  <button
                    key={i}
                    title={`${p.label} · line ${p.line ?? "?"}`}
                    onClick={() => seek(p.start)}
                    className="absolute inset-y-[2px] overflow-hidden whitespace-nowrap rounded-[5px] px-2 text-left text-[11px] font-medium"
                    style={{ left: `${(p.start / duration) * 100}%`, width: `calc(${((p.end - p.start) / duration) * 100}% - 2px)`, ...CLIP_STYLE[CLIP_COLORS[i % 4]] }}
                  >
                    {p.label}
                  </button>
                ))}
            </div>
            <div className="relative h-6 rounded-md bg-surface-2">
              {duration > 0 &&
                marks.map((m, i) => (
                  <span key={i} title={m.label} className="absolute inset-y-[-3px] w-0.5 rounded bg-[#E8A33D]" style={{ left: `${(m.end / duration) * 100}%` }} />
                ))}
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
