import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NarrationInfo } from "@studio/shared";
import { fmt, fmtTenths, nextStart, prevStart, segmentAt, usePlayer, type PlayerBus, type Segment, type Step } from "../lib/player";
import { Pause, Play } from "./Icons";

/**
 * The studio timeline: transport, a time ruler, and four tracks (scenes, animation steps, cues,
 * voice) on one zoomable strip. Click or drag anywhere to scrub; click a step to see where it
 * comes from and ask the assistant about it.
 */

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const TICKS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const LABEL_W = 84;

export function Timeline(props: {
  bus: PlayerBus;
  thumbs: Record<string, string | undefined>;
  infos: Record<string, NarrationInfo | null>;
  peaks: Record<string, number[] | null>;
  activeSceneId?: string;
  emptyHint: string;
  /** Ask the assistant about an animation step. */
  onAskStep?: (step: Step) => void;
  /** Show the voice track only when it matters (videos and web animations always). */
  showVoice?: boolean;
  right?: React.ReactNode;
}) {
  const { bus } = props;
  const st = usePlayer(bus, (s) => s);
  const { time, duration, playing, segments, steps, cues } = st;
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  const [picked, setPicked] = useState<Step | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const inner = width * zoom;
  const pps = duration > 0 ? inner / duration : 0;
  const x = (t: number) => t * pps;
  const pct = (t: number) => (duration > 0 ? `${(t / duration) * 100}%` : "0%");

  // Zoom resets when the content changes length a lot (a new build).
  useEffect(() => setPicked(null), [duration]);

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scroller.current;
    if (!el || zoom <= 1 || !playing) return;
    const px = x(time);
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = Math.max(0, px - el.clientWidth * 0.15);
  }, [time, playing, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Loop the scene under the playhead.
  // Only playback running across the end loops; a jump (next scene, a click) moves the loop.
  const loopSeg = useRef<Segment | null>(null);
  const lastTime = useRef(time);
  useEffect(() => {
    const prev = lastTime.current;
    lastTime.current = time;
    if (!st.loop || st.recording) {
      loopSeg.current = null;
      return;
    }
    const cur = loopSeg.current;
    const crossed = Boolean(cur) && playing && prev >= cur!.start && prev < cur!.end - 0.06 && time >= cur!.end - 0.06 && time - prev < 0.6;
    if (crossed) {
      bus.seek(cur!.start);
      lastTime.current = cur!.start;
      return;
    }
    if (!cur || time < cur.start || time >= cur.end - 0.06) loopSeg.current = segmentAt(segments, time + 0.001) ?? null;
    // The very end of the last scene: go round again.
    const seg = loopSeg.current;
    if (seg && playing && seg === segments[segments.length - 1] && time >= seg.end - 0.06) bus.seek(seg.start);
  }, [time, playing, st.loop, st.recording, segments, bus]);

  useTimelineKeys(bus, !st.recording && duration > 0, setZoom);

  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - r.left + el.scrollLeft) / (pps || 1)));
  };

  function scrub(e: React.PointerEvent) {
    if (!duration || e.button !== 0) return;
    setPicked(null);
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    bus.seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => bus.seek(timeAt(ev.clientX));
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  // Ctrl + wheel zooms around the pointer; plain wheel scrolls sideways when zoomed.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const t = (px + el.scrollLeft) / (pps || 1);
      setZoom((z) => {
        const nz = Math.max(1, Math.min(40, z * (e.deltaY < 0 ? 1.25 : 0.8)));
        requestAnimationFrame(() => (el.scrollLeft = Math.max(0, t * ((el.clientWidth * nz) / (duration || 1)) - px)));
        return nz;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pps, duration]);

  const tick = TICKS.find((s) => s * pps >= 64) ?? 600;
  const ticks = useMemo(() => {
    const out: number[] = [];
    if (duration > 0) for (let t = 0; t <= duration + 1e-6; t += tick) out.push(t);
    return out;
  }, [tick, duration]);

  // Hatched stretches where the animation waits for the voice to reach a cue.
  const waits = useMemo(
    () =>
      cues
        .map((c) => {
          const before = steps.filter((s) => s.sceneId === c.sceneId && s.end <= c.t + 1e-3).reduce((m, s) => Math.max(m, s.end), -1);
          const seg = segments.find((s) => s.id === c.sceneId);
          const from = before >= 0 ? before : (seg?.start ?? c.t);
          return c.t - from > 0.2 ? { from, to: c.t, name: c.name } : null;
        })
        .filter(Boolean) as { from: number; to: number; name: string }[],
    [cues, steps, segments],
  );

  const many = segments.length > 1;
  const next = nextStart(segments, time);
  const hasVoice = props.showVoice !== false;
  const zoomSlider = Math.round((Math.log(zoom) / Math.log(40)) * 100);

  return (
    <div className="@container/tl min-w-0 select-none border-t border-line bg-surface" data-timeline>
      {/* transport */}
      <div className="flex h-11 min-w-0 items-center gap-1 border-b border-line-2 px-2.5">
        {many && (
          <button className="icon-btn h-8 w-8" title="Previous scene ( [ )" disabled={!duration} onClick={() => bus.seek(prevStart(segments, time))}>
            <SkipBack />
          </button>
        )}
        <button
          className="grid h-8 w-8 flex-none place-items-center rounded-full bg-ink text-on-ink transition hover:scale-105 disabled:opacity-40"
          title={playing ? "Pause (Space)" : "Play (Space)"}
          disabled={!duration || st.recording}
          onClick={() => bus.toggle()}
        >
          {playing ? <Pause size={12} /> : <Play size={12} />}
        </button>
        {many && (
          <button className="icon-btn h-8 w-8" title="Next scene ( ] )" disabled={next === undefined} onClick={() => next !== undefined && bus.seek(next)}>
            <SkipFwd />
          </button>
        )}
        <span className="ml-1 whitespace-nowrap font-mono text-[12.5px] text-ink tabular-nums">
          {fmtTenths(time)}
          <span className="text-faint"> / {fmt(duration)}</span>
        </span>
        <span className="mx-1.5 h-5 w-px flex-none bg-line" />
        <label className="pill relative" title="Playback speed">
          {st.rate === 1 ? "1×" : `${st.rate}×`}
          <svg width="9" height="9" viewBox="0 0 10 10" className="text-faint">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <select className="absolute inset-0 cursor-pointer opacity-0" value={st.rate} onChange={(e) => bus.setRate(Number(e.target.value))} aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        {hasVoice && (
          <button className="pill" data-on={st.captions} title="Captions (C)" onClick={() => bus.setCaptions(!st.captions)}>
            CC
          </button>
        )}
        <button className="pill" data-on={st.loop} title="Loop the scene (L)" onClick={() => bus.setLoop(!st.loop)} disabled={st.recording}>
          <LoopIcon /> <span className="hidden @[720px]/tl:inline">Loop scene</span>
          <span className="@[720px]/tl:hidden">Loop</span>
        </button>
        <span className="flex-1" />
        {props.right}
        <span className="mx-1 h-5 w-px flex-none bg-line" />
        <div className="flex flex-none items-center gap-1 text-muted">
          <button className="icon-btn h-7 w-7" title="Zoom out (−)" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} disabled={zoom <= 1}>
            −
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={zoomSlider}
            onChange={(e) => setZoom(Math.pow(40, Number(e.target.value) / 100))}
            className="w-[84px] accent-[var(--color-accent)]"
            aria-label="Zoom"
          />
          <button className="icon-btn h-7 w-7" title="Zoom in (+)" onClick={() => setZoom((z) => Math.min(40, z * 1.5))}>
            +
          </button>
          <button className="pill" onClick={() => setZoom(1)} disabled={zoom === 1} title="Fit the whole timeline">
            Fit
          </button>
        </div>
      </div>

      {/* tracks */}
      <div className="relative grid pb-2.5 pr-2.5" style={{ gridTemplateColumns: `${LABEL_W}px minmax(0,1fr)` }}>
        <div className="grid pl-3 text-[11.5px] text-muted" style={{ gridTemplateRows: `22px 50px 26px 18px ${hasVoice ? "38px" : ""}`, rowGap: 6 }}>
          <div />
          <TrackLabel color="var(--color-ink)">Scenes</TrackLabel>
          <TrackLabel color="var(--color-context)">Animation</TrackLabel>
          <TrackLabel color="var(--color-cue)" diamond>
            Cues
          </TrackLabel>
          {hasVoice && <TrackLabel color="var(--color-voice)">Voice</TrackLabel>}
        </div>
        <div
          ref={scroller}
          className="tl-scroll relative min-w-0 overflow-x-auto overflow-y-hidden"
          onPointerMove={(e) => duration && setHover(timeAt(e.clientX))}
          onPointerLeave={() => setHover(null)}
        >
          <div className="relative grid" style={{ width: zoom === 1 ? "100%" : inner, gridTemplateRows: `22px 50px 26px 18px ${hasVoice ? "38px" : ""}`, rowGap: 6 }}>
            {/* ruler */}
            <div className="relative cursor-ew-resize border-b border-line-2" onPointerDown={scrub}>
              {ticks.map((t) => (
                <span key={t} className="absolute bottom-0 h-full" style={{ left: pct(t) }}>
                  <i className="absolute bottom-0 block h-[7px] w-px bg-line" />
                  <span className="absolute left-1 top-0.5 whitespace-nowrap font-mono text-[10.5px] text-faint">{tick < 1 ? fmtTenths(t) : fmt(t)}</span>
                </span>
              ))}
            </div>

            {/* scenes */}
            <div className="relative rounded-lg bg-surface-2" onPointerDown={scrub}>
              {duration > 0 &&
                segments.map((s, i) => {
                  const on = props.activeSceneId === s.id;
                  const thumb = props.thumbs[s.id];
                  return (
                    <button
                      key={s.id}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => bus.seek(s.start + 0.01)}
                      title={`${i + 1}. ${s.title} · ${fmt(s.end - s.start)}`}
                      className="absolute inset-y-[2px] overflow-hidden rounded-[7px] bg-stage text-left"
                      style={{
                        left: pct(s.start),
                        width: `calc(${((s.end - s.start) / duration) * 100}% - 3px)`,
                        boxShadow: on ? "0 0 0 2px var(--color-accent)" : "inset 0 0 0 1px rgba(0,0,0,.2)",
                        backgroundImage: thumb ? `url("${thumb}")` : undefined,
                        backgroundSize: "auto 100%",
                        backgroundRepeat: "repeat-x",
                      }}
                    >
                      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-[3px] pt-3 text-[11px] font-semibold text-white">
                        {i + 1}. {s.title}
                      </span>
                      {x(s.end - s.start) > 90 && (
                        <span className="absolute right-1 top-1 rounded bg-black/55 px-1 font-mono text-[10px] text-white">{fmt(s.end - s.start)}</span>
                      )}
                    </button>
                  );
                })}
              {duration === 0 && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[12px] text-faint">{props.emptyHint}</span>}
            </div>

            {/* animation steps */}
            <div className="relative rounded-lg bg-surface-2" onPointerDown={scrub}>
              {waits.map((w, i) => (
                <span
                  key={`w${i}`}
                  title={`Waits for the voice to say ◆ ${w.name}`}
                  className="absolute inset-y-[7px] rounded-[3px]"
                  style={{ left: pct(w.from), width: pct(w.to - w.from), background: "repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in srgb, var(--color-cue) 30%, transparent) 4px 6px)" }}
                />
              ))}
              {steps.map((s, i) => {
                const w = x(s.end - s.start);
                const sceneIndex = segments.findIndex((g) => g.id === s.sceneId);
                const on = picked === s;
                return (
                  <button
                    key={i}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      bus.seek(s.start);
                      setPicked(on ? null : s);
                    }}
                    title={`${s.label}${s.line ? ` · line ${s.line}` : ""}`}
                    className="absolute inset-y-[3px] overflow-hidden whitespace-nowrap rounded-[5px] px-1.5 text-left text-[10.5px] font-semibold leading-[20px]"
                    style={{
                      left: pct(s.start),
                      width: `max(3px, calc(${((s.end - s.start) / (duration || 1)) * 100}% - 2px))`,
                      ...(sceneIndex % 2 ? CLIP_B : CLIP_A),
                      ...(on ? { boxShadow: "0 0 0 2px var(--color-accent)", zIndex: 2 } : {}),
                    }}
                  >
                    {w > 34 ? s.label : ""}
                  </button>
                );
              })}
            </div>

            {/* cues */}
            <div className="relative" onPointerDown={scrub}>
              {cues.map((c, i) => (
                <span
                  key={i}
                  title={`◆ ${c.name} · ${fmtTenths(c.t)}`}
                  className="absolute top-[3px] h-[10px] w-[10px] -translate-x-1/2 rotate-45 rounded-[2px]"
                  style={{ left: pct(c.t), background: "var(--color-cue)", boxShadow: "0 0 0 2px var(--color-surface)" }}
                />
              ))}
              {duration > 0 && cues.length === 0 && <span className="absolute left-2 top-0 text-[11px] text-faint">No cues yet. Cues tie animations to words in the narration.</span>}
            </div>

            {/* voice */}
            {hasVoice && (
              <div className="relative rounded-lg bg-surface-2" onPointerDown={scrub}>
                {duration > 0 &&
                  segments.map((s) => {
                    const info = props.infos[s.id];
                    const live = st.live && st.live.sceneId === s.id ? st.live : null;
                    if (live) return <LiveClip key={s.id} start={live.start} seconds={Math.max(0.05, Math.min(time, s.end) - live.start)} levels={live.levels} pct={pct} />;
                    if (!info) return null;
                    const me = info.source === "recording";
                    const len = Math.min(info.duration, s.end - s.start);
                    return (
                      <div
                        key={s.id}
                        className="absolute inset-y-[2px] overflow-hidden rounded-[6px]"
                        title={`${me ? "Your voice" : "AI voice"} · ${info.duration.toFixed(1)} s${info.stale ? " · the script changed since" : ""}`}
                        style={{
                          left: pct(s.start),
                          width: pct(len),
                          background: `color-mix(in srgb, ${me ? "var(--color-rec)" : "var(--color-voice)"} 11%, var(--color-surface))`,
                          boxShadow: info.stale ? "inset 0 0 0 1.5px var(--color-cue)" : `inset 0 0 0 1px color-mix(in srgb, ${me ? "var(--color-rec)" : "var(--color-voice)"} 32%, var(--color-surface))`,
                        }}
                      >
                        <Wave peaks={props.peaks[s.id]} color={me ? "var(--color-rec)" : "var(--color-voice)"} />
                        {x(len) > 80 && (
                          <span className="absolute left-1.5 top-0.5 text-[10px] font-semibold" style={{ color: info.stale ? "var(--color-warn)" : me ? "var(--color-rec)" : "var(--color-voice)" }}>
                            {info.stale ? "Out of date" : me ? `Your voice${info.take ? ` · take ${info.take.slice(5)}` : ""}` : "AI voice"}
                          </span>
                        )}
                      </div>
                    );
                  })}
                {duration > 0 && !segments.some((s) => props.infos[s.id] || st.live?.sceneId === s.id) && (
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-faint">No voice yet. Add one in Voice-over.</span>
                )}
              </div>
            )}

            {/* playhead and hover line */}
            {duration > 0 && (
              <>
                {hover !== null && !st.recording && (
                  <div className="pointer-events-none absolute inset-y-0 z-[4] w-px bg-ink/30" style={{ left: x(hover) }}>
                    <span className="absolute -top-0.5 left-1 whitespace-nowrap rounded bg-ink px-1 font-mono text-[10px] text-on-ink">{fmtTenths(hover)}</span>
                  </div>
                )}
                <div className="pointer-events-none absolute -bottom-1 top-0 z-[5]" style={{ left: x(time) }}>
                  <div className="absolute inset-y-0 -left-px w-[2px] rounded" style={{ background: st.recording ? "var(--color-rec)" : "var(--color-ink)" }} />
                  <div className="absolute -left-[6px] -top-px h-3 w-3" style={{ background: st.recording ? "var(--color-rec)" : "var(--color-ink)", clipPath: "polygon(0 0,100% 0,100% 55%,50% 100%,0 55%)" }} />
                </div>
              </>
            )}
          </div>
        </div>

        {picked && (
          <StepCard
            step={picked}
            scene={segments.find((s) => s.id === picked.sceneId)}
            cue={cues.find((c) => c.sceneId === picked.sceneId && Math.abs(c.t - picked.start) < 0.05)?.name}
            left={Math.min(Math.max(LABEL_W, LABEL_W + x(picked.start) - (scroller.current?.scrollLeft ?? 0)), LABEL_W + width - 280)}
            onClose={() => setPicked(null)}
            onAsk={
              props.onAskStep
                ? () => {
                    props.onAskStep!(picked);
                    setPicked(null);
                  }
                : undefined
            }
            onPlay={() => {
              bus.seek(picked.start);
              bus.play();
              setPicked(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

const CLIP_A: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-context) 13%, var(--color-surface))",
  color: "var(--color-context)",
  boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--color-context) 35%, var(--color-surface))",
};
const CLIP_B: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-assistant) 11%, var(--color-surface))",
  color: "var(--color-assistant)",
  boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--color-assistant) 32%, var(--color-surface))",
};

function TrackLabel(props: { color: string; diamond?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <i className={`block h-[7px] w-[7px] flex-none ${props.diamond ? "rotate-45 rounded-[1px]" : "rounded-full"}`} style={{ background: props.color }} />
      {props.children}
    </div>
  );
}

function StepCard(props: { step: Step; scene?: Segment; cue?: string; left: number; onClose: () => void; onAsk?: () => void; onPlay: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && props.onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    const t = setTimeout(() => window.addEventListener("pointerdown", down), 0);
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [props]);
  const { step } = props;
  return (
    <div ref={ref} className="absolute bottom-[calc(100%-22px)] z-20 w-[272px] rounded-xl border border-line bg-surface p-3 text-[12.5px] shadow-2 animate-in" style={{ left: props.left }}>
      <div className="flex items-baseline gap-2">
        <b className="min-w-0 flex-1 truncate text-[13px]">{step.label}</b>
        <span className="font-mono text-[11px] text-faint">
          {fmtTenths(step.start)} – {fmtTenths(step.end)}
        </span>
      </div>
      <div className="mt-0.5 text-muted">
        {props.scene ? props.scene.title : "Scene"}
        {step.line ? ` · line ${step.line}` : ""}
        {props.cue ? ` · starts at ◆ ${props.cue}` : ""}
      </div>
      <div className="mt-2.5 flex gap-1.5">
        {props.onAsk && (
          <button className="btn btn-sm" onClick={props.onAsk}>
            Change this step…
          </button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={props.onPlay}>
          <Play size={10} /> Play from here
        </button>
      </div>
    </div>
  );
}

/** Waveform drawn from loudness buckets, stretched to the clip. */
export function Wave(props: { peaks: number[] | null | undefined; color: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = () => {
      const r = cv.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
      const g = cv.getContext("2d")!;
      g.scale(dpr, dpr);
      g.clearRect(0, 0, r.width, r.height);
      g.fillStyle = getComputedStyle(cv).color;
      const peaks = props.peaks ?? [];
      if (!peaks.length) return;
      const bar = 2;
      const n = Math.max(1, Math.floor(r.width / (bar + 1)));
      for (let i = 0; i < n; i++) {
        const a = Math.floor((i / n) * peaks.length);
        const b = Math.max(a + 1, Math.floor(((i + 1) / n) * peaks.length));
        let m = 0;
        for (let j = a; j < b && j < peaks.length; j++) m = Math.max(m, peaks[j]);
        const h = Math.max(1, m * r.height * 0.78);
        g.fillRect(i * (bar + 1), (r.height - h) / 2, bar, h);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [props.peaks]);
  return <canvas ref={ref} className={props.className ?? "absolute inset-0 h-full w-full opacity-80"} style={{ color: props.color }} />;
}

function LiveClip(props: { start: number; seconds: number; levels: number[]; pct: (t: number) => string }) {
  return (
    <div
      className="absolute inset-y-[2px] overflow-hidden rounded-[6px]"
      style={{ left: props.pct(props.start), width: props.pct(Math.max(0.05, props.seconds)), background: "color-mix(in srgb, var(--color-rec) 12%, var(--color-surface))", boxShadow: "inset 0 0 0 1px var(--color-rec)" }}
    >
      <Wave peaks={props.levels} color="var(--color-rec)" />
      <span className="absolute left-1.5 top-0.5 flex items-center gap-1 text-[10px] font-semibold text-rec">
        <i className="block h-1.5 w-1.5 animate-pulse rounded-full bg-rec" /> Recording
      </span>
    </div>
  );
}

/**
 * Space plays/pauses, ←/→ move 1 s (Shift: 5 s), , and . step a frame, [ and ] jump scenes,
 * Home/End, L loops the scene, C toggles captions, + and − zoom. Ignored while typing.
 */
function useTimelineKeys(bus: PlayerBus, enabled: boolean, setZoom: React.Dispatch<React.SetStateAction<number>>) {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector("[role=dialog]")) return;
      const s = bus.get();
      const frame = 1 / 30;
      if (e.key === " ") bus.toggle();
      else if (e.key === "ArrowLeft") bus.seek(s.time - (e.shiftKey ? 5 : 1));
      else if (e.key === "ArrowRight") bus.seek(s.time + (e.shiftKey ? 5 : 1));
      else if (e.key === ",") (bus.pause(), bus.seek(s.time - frame));
      else if (e.key === ".") (bus.pause(), bus.seek(s.time + frame));
      else if (e.key === "[") bus.seek(prevStart(s.segments, s.time));
      else if (e.key === "]") {
        const n = nextStart(s.segments, s.time);
        if (n !== undefined) bus.seek(n);
      } else if (e.key === "Home") bus.seek(0);
      else if (e.key === "End") bus.seek(s.duration);
      else if (e.key === "l" || e.key === "L") bus.setLoop(!s.loop);
      else if (e.key === "c" || e.key === "C") bus.setCaptions(!s.captions);
      else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(40, z * 1.5));
      else if (e.key === "-") setZoom((z) => Math.max(1, z / 1.5));
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bus, enabled, setZoom]);
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
const LoopIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7V6a2 2 0 0 1 2-2h7l-2-2M13 9v1a2 2 0 0 1-2 2H4l2 2" />
  </svg>
);

/** Big play button over the stage before playback starts (the first frame is often empty). */
export function StartOverlay(props: { show: boolean; onPlay: () => void }) {
  if (!props.show) return null;
  return (
    <button className="group absolute inset-0 grid place-items-center" onClick={(e) => (e.stopPropagation(), props.onPlay())} title="Play (Space)">
      <span className="grid h-16 w-16 place-items-center rounded-full bg-white/90 text-black shadow-[0_10px_30px_-8px_rgba(0,0,0,.6)] transition group-hover:scale-105">
        <Play size={22} />
      </span>
    </button>
  );
}
