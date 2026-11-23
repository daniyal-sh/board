import { useEffect, useRef, useState } from "react";
import type { Aspect, FullPreview, NarrationInfo, SceneMeta, SceneTimeline, Selection, VideoEnvStatus } from "@studio/shared";
import { errorMessage, studio } from "../lib/api";
import { segmentAt, usePlayer, type Cue, type PlayerBus, type Segment, type Step } from "../lib/player";
import { Refresh } from "./Icons";
import { StartOverlay } from "./Timeline";
import { Caption, FullscreenButton, StageFrame, StatusNote } from "./StageParts";

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

const CUE_NAME = /“(.+?)”/;

/** Steps and cues of one scene's render, moved to where the scene starts. */
function stepsOf(tl: SceneTimeline | undefined, sceneId: string, offset: number): { steps: Step[]; cues: Cue[] } {
  const steps: Step[] = [];
  const cues: Cue[] = [];
  for (const p of tl?.plays ?? []) {
    if (p.kind === "play") steps.push({ start: p.start + offset, end: p.end + offset, label: p.label, sceneId, line: p.line });
    else if (p.kind === "mark") cues.push({ t: p.end + offset, name: CUE_NAME.exec(p.label)?.[1] ?? p.label, sceneId });
  }
  return { steps, cues };
}

type Mode = "scene" | "whole";

/**
 * Manim videos. "Whole video" plays the drafts of every scene joined into one; "This scene" plays
 * one scene's draft. Either way the shared player (and so the timeline) sees a list of scenes,
 * the animation steps and the cues.
 */
export function VideoStage(props: {
  projectId: string;
  scene?: SceneMeta;
  scenes: SceneMeta[];
  revision: number;
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  aspect?: Aspect;
  /** Whole-video mode: the scene under the playhead changed. */
  onActiveScene?: (sceneId: string) => void;
  bus: PlayerBus;
  infos: Record<string, NarrationInfo | null>;
  leading?: React.ReactNode;
  /** The assistant is working: wait before joining scenes (it may be rendering them). */
  busy?: boolean;
}) {
  const { bus } = props;
  const [env, setEnv] = useState<VideoEnvStatus | null>(null);
  const [mode, setMode] = useState<Mode>("whole");
  const [url, setUrl] = useState<string | null>(null);
  const [tl, setTl] = useState<SceneTimeline | null>(null);
  const [full, setFull] = useState<FullPreview | null>(null);
  const [fullTimelines, setFullTimelines] = useState<Record<string, SceneTimeline>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [selBox, setSelBox] = useState<Box | null>(null);
  const [builtAt, setBuiltAt] = useState<number | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const time = usePlayer(bus, (s) => s.time);
  const playing = usePlayer(bus, (s) => s.playing);
  const captions = usePlayer(bus, (s) => s.captions);
  const rate = useRef(1);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void studio.video.status().then(setEnv);
    return studio.video.onProgress((m) => setWorking(m));
  }, []);

  // With no scene to show alone, show them all.
  useEffect(() => {
    if (mode === "scene" && !props.scene) setMode("whole");
  }, [mode, props.scene]);

  // ---------------------------------------------------------------- one scene
  useEffect(() => {
    if (mode !== "scene" || !props.scene) return;
    let live = true;
    void Promise.all([studio.video.sceneUrl(props.projectId, props.scene.id), studio.video.timeline(props.projectId, props.scene.id)]).then(([u, t]) => {
      if (!live) return;
      setUrl(u);
      setTl(t);
      setBuiltAt(Date.now());
    });
    setSelBox(null);
    return () => {
      live = false;
    };
  }, [mode, props.projectId, props.scene?.id, props.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- every scene
  const loads = useRef(0);
  async function loadFull() {
    const mine = ++loads.current;
    setWorking("Preparing the whole video…");
    setRenderError(null);
    try {
      const f = await studio.video.fullPreview(props.projectId);
      const tls: Record<string, SceneTimeline> = {};
      await Promise.all(
        f.segments.map(async (s) => {
          const t = await studio.video.timeline(props.projectId, s.sceneId);
          if (t) tls[s.sceneId] = t;
        }),
      );
      if (mine !== loads.current) return;
      setFull(f);
      setFullTimelines(tls);
      setBuiltAt(Date.now());
      if (!f.ok && f.failed.length) setRenderError(f.failed.map((x) => `${x.title || "Video"}: ${x.log}`).join("\n\n"));
    } catch (e) {
      if (mine === loads.current) setRenderError(errorMessage(e));
    } finally {
      if (mine === loads.current) setWorking(null);
    }
  }

  useEffect(() => {
    if (mode === "whole" && env?.ready && props.scenes.length && !props.busy) void loadFull();
  }, [mode, props.projectId, props.revision, env?.ready, props.scenes.length, props.busy]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- what the player shows
  const segments: Segment[] =
    mode === "whole"
      ? (full?.segments ?? []).map((s) => ({ id: s.sceneId, title: s.title, start: s.start, end: s.end }))
      : props.scene && (tl?.duration || video.current?.duration)
        ? [{ id: props.scene.id, title: props.scene.title, start: 0, end: tl?.duration || video.current?.duration || 0 }]
        : [];
  const duration = mode === "whole" ? (full?.duration ?? 0) : segments[0]?.end ?? 0;
  const src = mode === "whole" ? (full?.url ?? null) : url;

  useEffect(() => {
    const all = mode === "whole" ? segments.map((s) => stepsOf(fullTimelines[s.id], s.id, s.start)) : props.scene ? [stepsOf(tl ?? undefined, props.scene.id, 0)] : [];
    bus.set({
      ready: Boolean(src),
      duration,
      segments,
      steps: all.flatMap((a) => a.steps),
      cues: all.flatMap((a) => a.cues),
      view: mode,
    });
  }, [src, duration, mode, full, fullTimelines, tl, props.scene?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new source starts from the top (or where the teacher asked to go).
  useEffect(() => {
    bus.set({ time: pendingSeek.current ?? 0, playing: false });
  }, [src, bus]);

  // Drive the <video> from the shared player.
  useEffect(
    () =>
      bus.attach({
        play: () => void video.current?.play().catch(() => {}),
        pause: () => video.current?.pause(),
        seek: (t) => {
          const v = video.current;
          if (v && v.readyState > 0) v.currentTime = t;
          else pendingSeek.current = t;
        },
        setRate: (r) => {
          rate.current = r;
          if (video.current) video.current.playbackRate = r;
        },
        setCaptions: () => {},
      }),
    [bus],
  );

  // Report the time smoothly while playing (timeupdate alone is only ~4 times a second).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (video.current) bus.set({ time: video.current.currentTime });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, bus]);

  const current = mode === "whole" ? segmentAt(segments, time) : segments[0];

  // The storyboard follows the playhead, and picking a scene jumps there.
  useEffect(() => {
    if (mode === "whole" && current && current.id !== props.scene?.id) props.onActiveScene?.(current.id);
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (mode !== "whole" || !props.scene) return;
    const seg = segments.find((s) => s.id === props.scene!.id);
    if (seg && current?.id !== seg.id) bus.seek(seg.start + 0.01);
  }, [props.scene?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setBuiltAt(Date.now());
    } catch (e) {
      setRenderError(errorMessage(e));
    } finally {
      setWorking(null);
    }
  }

  function onStageClick(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    bus.pause();
    const seg = current;
    const sceneId = seg?.id;
    const timeline = mode === "whole" ? (sceneId ? fullTimelines[sceneId] : undefined) : (tl ?? undefined);
    const local = seg ? time - seg.start : time;
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

  const info = current ? props.infos[current.id] : null;
  const local = current ? time - current.start : 0;
  const caption = captions && info ? info.captions.find((c) => local >= c.start && local <= c.end + 0.15)?.text : undefined;

  if (env && !env.ready) return <VideoSetup onReady={setEnv} />;

  return (
    <div className="grid h-full min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-2.5 overflow-hidden px-4 pb-3 pt-3">
      <div className="@container/stagebar flex min-w-0 items-center gap-2">
        {props.leading}
        <div className="seg flex-none">
          <button data-on={mode === "whole"} onClick={() => setMode("whole")} disabled={!props.scenes.length}>
            Whole video
          </button>
          <button data-on={mode === "scene"} onClick={() => setMode("scene")} disabled={!props.scene}>
            This scene
          </button>
        </div>
        <span className="flex-1" />
        <StatusNote working={working} builtAt={builtAt} failed={Boolean(renderError)} />
        <button
          className="icon-btn flex-none"
          disabled={Boolean(working) || (mode === "scene" && !props.scene)}
          onClick={() => void (mode === "whole" ? loadFull() : renderNow())}
          title={mode === "whole" ? "Render changed scenes again" : "Render this scene again"}
        >
          <Refresh size={15} />
        </button>
      </div>

      <StageFrame
        aspect={props.aspect}
        frameRef={frameRef}
        agentView={{
          project: props.projectId,
          view: mode === "whole" ? "whole video" : "one scene",
          scene: current?.title ?? props.scene?.title ?? "",
          time: local,
          total: time,
          playing,
        }}
      >
        {src ? (
          <>
            <video
              ref={video}
              key={src}
              src={src}
              poster={(mode === "scene" ? props.scene?.thumbUrl : props.scenes[0]?.thumbUrl) ?? undefined}
              className="h-full w-full"
              onLoadedMetadata={(e) => {
                e.currentTarget.playbackRate = rate.current;
                if (pendingSeek.current !== null) {
                  e.currentTarget.currentTime = pendingSeek.current;
                  pendingSeek.current = null;
                }
                if (mode === "scene") bus.set({ duration: tl?.duration || e.currentTarget.duration });
              }}
              onTimeUpdate={(e) => bus.set({ time: e.currentTarget.currentTime })}
              onSeeked={(e) => bus.set({ time: e.currentTarget.currentTime })}
              onPlay={() => bus.set({ playing: true })}
              onPause={() => bus.set({ playing: false })}
              onEnded={(e) => {
                bus.set({ playing: false });
                const s = bus.get();
                if (s.loop && !s.recording) {
                  const seg = segmentAt(s.segments, e.currentTarget.currentTime - 0.1);
                  bus.seek(seg?.start ?? 0);
                  bus.play();
                }
              }}
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
            <Caption text={caption} />
            <div className="absolute right-2.5 top-2.5 flex gap-1 opacity-0 transition-opacity group-hover/stage:opacity-100">
              <span className="glass hidden rounded-lg px-2.5 py-1 text-[11px] @lg:block">Click anything to change it</span>
              <FullscreenButton target={frameRef} />
            </div>
            <StartOverlay show={!playing && time < 0.05} onPlay={() => bus.play()} />
          </>
        ) : (
          <div className="grid h-full place-items-center p-8 text-center text-white/70">
            {working ? (
              <div className="flex flex-col items-center gap-3">
                <div className="spinner" />
                <span>{working}</span>
              </div>
            ) : props.busy && !full ? (
              <div className="flex flex-col items-center gap-3">
                <div className="spinner" />
                <span>The assistant is working on the scenes…</span>
              </div>
            ) : mode === "whole" ? (
              <span>{props.scenes.length ? "No scenes have rendered yet." : "Scenes appear here once the assistant writes them."}</span>
            ) : props.scene ? (
              <div className="flex flex-col items-center gap-3">
                <span>This scene hasn't been rendered yet.</span>
                <button className="btn btn-sm" onClick={() => void renderNow()}>
                  Render draft
                </button>
              </div>
            ) : (
              "Scenes appear here once the assistant writes them."
            )}
          </div>
        )}
        {renderError && (
          <div className="absolute inset-x-3 top-3 max-h-[60%] overflow-auto rounded-xl bg-bad-soft p-3 font-mono text-[11.5px] text-bad shadow-1">
            <div className="mb-1 flex items-start gap-3 font-sans">
              <b className="min-w-0 flex-1 text-[12.5px]">{mode === "whole" ? "Some scenes didn't render (left out of the preview)" : "Render failed"}</b>
              <button className="flex-none text-[12px] underline" onClick={() => setRenderError(null)}>
                Hide
              </button>
            </div>
            <pre className="whitespace-pre-wrap">{renderError}</pre>
            <div className="mt-2 font-sans text-[12px] text-ink-2">Ask the assistant to fix it. It sees the same errors.</div>
          </div>
        )}
      </StageFrame>
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
        <h2 className="serif m-0 text-[24px]">One-time video setup</h2>
        <p className="mt-1 text-ink-2">
          Videos are rendered on your computer with Manim. Board will download Python, Manim and LaTeX (about 300 MB) into its own folder. Nothing else on your
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
        <button className="btn btn-accent mt-2" disabled={running} onClick={() => void go()}>
          {running ? <span className="spinner border-white border-r-transparent" /> : null}
          {running ? "Installing…" : error ? "Try again" : "Set up video tools"}
        </button>
      </div>
    </div>
  );
}
