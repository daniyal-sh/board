import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NarrationInfo, SpokenWord, TakeInfo } from "@studio/shared";
import { errorMessage, studio } from "../lib/api";
import { fmtTenths } from "../lib/player";
import { openMic, toPcm16k, type Mic } from "./Recorder";
import { Close, Pause, Play } from "./Icons";

/**
 * Editing the teacher's recording of one scene, like a document: every word heard sits under the
 * waveform. Drag across words to select them, then cut them or record just that bit again.
 * Drag a cue (◆) to change when its animation starts. Every take is kept; switch between them.
 */
export function TakeEditor(props: {
  projectId: string;
  sceneId: string;
  sceneTitle: string;
  sceneNumber: number;
  info: NarrationInfo;
  deviceId?: string;
  onChanged: (info: NarrationInfo) => void;
  onClose: () => void;
}) {
  const { info } = props;
  const words = info.words ?? [];
  const duration = info.duration;
  const [takes, setTakes] = useState<TakeInfo[]>([]);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(900);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [punch, setPunch] = useState<"preroll" | "recording" | null>(null);
  const [dragCue, setDragCue] = useState<{ name: string; t: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stopAt = useRef<number | null>(null);

  const reloadTakes = () => void studio.voice.takes(props.projectId, props.sceneId).then(setTakes).catch(() => {});
  useEffect(reloadTakes, [props.projectId, props.sceneId, info.audioUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void studio.voice.peaks(props.projectId, props.sceneId, Math.min(20000, Math.max(200, duration * 120))).then(setPeaks);
  }, [props.projectId, props.sceneId, info.audioUrl, duration]);
  useEffect(() => studio.voice.onProgress((m) => setBusy((b) => (b ? m : b))), []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // A fresh player for each version of the audio.
  useEffect(() => {
    const a = new Audio(info.audioUrl);
    audio.current = a;
    a.onplay = () => setPlaying(true);
    a.onpause = () => setPlaying(false);
    a.onended = () => setPlaying(false);
    let raf = 0;
    const tick = () => {
      if (!a.paused) {
        setCursor(a.currentTime);
        if (stopAt.current !== null && a.currentTime >= stopAt.current) {
          a.pause();
          stopAt.current = null;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    setSel(null);
    return () => {
      cancelAnimationFrame(raf);
      a.pause();
    };
  }, [info.audioUrl]);

  const inner = Math.max(width, width * zoom);
  const pps = duration > 0 ? (inner - 16) / duration : 1;
  const X = (t: number) => 8 + t * pps;
  const T = (clientX: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - r.left + el.scrollLeft - 8) / pps));
  };

  /** Snap a selection to whole words when it starts or ends inside one. */
  function snap(a: number, b: number): [number, number] {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const ws = words.find((w) => lo >= w.s && lo <= w.e);
    const we = [...words].reverse().find((w) => hi >= w.s && hi <= w.e);
    return [ws ? Math.max(0, ws.s - 0.03) : lo, we ? Math.min(duration, we.e + 0.03) : hi];
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || busy || punch) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const a = T(e.clientX);
    let moved = false;
    const move = (ev: PointerEvent) => {
      const b = T(ev.clientX);
      if (Math.abs(b - a) * pps > 4) moved = true;
      if (moved) setSel(snap(a, b));
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (!moved) {
        // A click moves the cursor (a double-click selects the word).
        const t = T(ev.clientX);
        setSel(null);
        setCursor(t);
        if (audio.current) audio.current.currentTime = t;
      }
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  function play(from?: number, to?: number) {
    const a = audio.current;
    if (!a) return;
    if (!a.paused && from === undefined) {
      a.pause();
      return;
    }
    a.currentTime = from ?? cursor;
    stopAt.current = to ?? null;
    void a.play();
  }

  async function run(message: string, fn: () => Promise<NarrationInfo | null>) {
    setBusy(message);
    setError(null);
    audio.current?.pause();
    try {
      const next = await fn();
      if (next) props.onChanged(next);
      setSel(null);
      reloadTakes();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  // ---------------------------------------------------------------- re-record a bit
  const mic = useRef<Mic | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const preroll = useRef<(() => void) | null>(null);
  // Closing the editor mid re-record: stop listening and throw the bit away.
  useEffect(
    () => () => {
      cancelled.current = true;
      preroll.current?.();
      if (rec.current && rec.current.state !== "inactive") rec.current.stop();
      mic.current?.close();
      mic.current = null;
    },
    [],
  );
  async function punchIn() {
    if (!sel) return;
    const [a, b] = sel;
    setError(null);
    cancelled.current = false;
    try {
      mic.current = await openMic(props.deviceId);
    } catch (e) {
      setError(`Can't use the microphone: ${errorMessage(e)}`);
      return;
    }
    // Two seconds of what comes before, so the new words flow on from it.
    setPunch("preroll");
    const pre = Math.max(0, a - 2);
    const au = audio.current!;
    au.currentTime = pre;
    stopAt.current = a;
    const startRecording = () => {
      const chunks: Blob[] = [];
      const r = new MediaRecorder(mic.current!.stream);
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = async () => {
        mic.current?.close();
        mic.current = null;
        rec.current = null;
        setPunch(null);
        if (!chunks.length || cancelled.current) {
          cancelled.current = false;
          return;
        }
        await run("Putting your new words in…", async () => {
          const pcm = await toPcm16k(new Blob(chunks, { type: r.mimeType }));
          return studio.voice.editTake(props.projectId, props.sceneId, { type: "replace", start: a, end: b, pcm16k: pcm });
        });
      };
      r.start(200);
      rec.current = r;
      setPunch("recording");
    };
    if (a - pre < 0.05) startRecording();
    else {
      const onPause = () => {
        au.removeEventListener("pause", onPause);
        preroll.current = null;
        if (mic.current && !cancelled.current) startRecording();
      };
      au.addEventListener("pause", onPause);
      preroll.current = () => au.removeEventListener("pause", onPause);
      void au.play();
    }
  }
  const cancelled = useRef(false);
  function finishPunch(keep: boolean) {
    if (punch === "preroll") {
      preroll.current?.();
      preroll.current = null;
      audio.current?.pause();
      mic.current?.close();
      mic.current = null;
      setPunch(null);
      return;
    }
    cancelled.current = !keep;
    rec.current?.stop();
  }

  // Keys: Space plays (or finishes a re-record), Delete cuts the selection, Escape clears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (punch) {
        if (e.key === " " || e.key === "Enter") (e.preventDefault(), punch === "recording" && finishPunch(true));
        else if (e.key === "Escape") (e.preventDefault(), finishPunch(false));
        return;
      }
      if (busy) return;
      if (e.key === " ") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (sel && audio.current?.paused) play(sel[0], sel[1]);
        else play();
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        e.preventDefault();
        void run("Cutting…", () => studio.voice.editTake(props.projectId, props.sceneId, { type: "cut", start: sel[0], end: sel[1] }));
      } else if (e.key === "Escape") setSel(null);
      else if ((e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey) && takes.find((x) => x.active)?.canUndo) {
        e.preventDefault();
        void run("Undoing…", () => studio.voice.undoTakeEdit(props.projectId, props.sceneId));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ---------------------------------------------------------------- cue dragging
  function dragMark(e: React.PointerEvent, name: string) {
    e.stopPropagation();
    if (busy || punch) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setDragCue({ name, t: T(ev.clientX) });
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      const t = T(ev.clientX);
      setDragCue(null);
      if (Math.abs(t - (info.marks[name] ?? 0)) > 0.04) void run(`Moving ◆ ${name}…`, () => studio.voice.editTake(props.projectId, props.sceneId, { type: "marks", marks: { [name]: t } }));
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  const active = takes.find((t) => t.active);
  const shown = visibleWords(words, X);

  return (
    <div className="flex min-w-0 select-none flex-col border-t border-line bg-surface" style={{ height: 292 }}>
      <div className="flex min-w-0 flex-none items-center gap-2 border-b border-line-2 px-3.5 py-2">
        <b className="text-[13px]">
          Scene {props.sceneNumber} · your voice
        </b>
        <div className="flex min-w-0 shrink gap-1.5 overflow-x-auto">
          {takes
            .slice()
            .reverse()
            .map((t) => (
              <button
                key={t.id}
                disabled={Boolean(busy || punch)}
                onClick={() => !t.active && void run(`Switching to take ${t.n}…`, () => studio.voice.useTake(props.projectId, props.sceneId, t.id))}
                className="inline-flex h-7 items-center gap-1.5 rounded-[7px] border px-2.5 text-[12.5px] font-medium"
                style={t.active ? { borderColor: "var(--color-rec)", color: "var(--color-rec)", background: "var(--color-rec-soft)" } : { borderColor: "var(--color-line)", color: "var(--color-ink-2)" }}
                title={t.createdAt ? new Date(t.createdAt).toLocaleString() : undefined}
              >
                {t.active && <i className="block h-1.5 w-1.5 rounded-full bg-rec" />}
                Take {t.n} · {t.duration.toFixed(1)} s
              </button>
            ))}
        </div>
        {busy ? (
          <span className="flex min-w-0 flex-1 items-center justify-end gap-2 text-[12px] text-muted">
            <span className="spinner flex-none" /> <span className="truncate">{busy}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-right text-[12px] text-muted">Drag across words to select · double-click a word · drag a ◆ to retime</span>
        )}
        <button
          className="btn btn-ghost btn-sm"
          disabled={!active?.canUndo || Boolean(busy || punch)}
          onClick={() => void run("Undoing…", () => studio.voice.undoTakeEdit(props.projectId, props.sceneId))}
          title="Undo the last edit (Ctrl Z)"
        >
          ↺ Undo
        </button>
        <div className="flex items-center gap-1 text-muted">
          <button className="icon-btn h-7 w-7" onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>
            −
          </button>
          <input type="range" min={0} max={100} value={Math.round((Math.log(zoom) / Math.log(12)) * 100)} onChange={(e) => setZoom(Math.pow(12, Number(e.target.value) / 100))} className="w-[70px] accent-[var(--color-accent)]" aria-label="Zoom" />
          <button className="icon-btn h-7 w-7" onClick={() => setZoom((z) => Math.min(12, z * 1.5))}>
            +
          </button>
        </div>
        <button className="icon-btn h-8 w-8" onClick={props.onClose} disabled={Boolean(punch)} title="Back to the timeline">
          <Close size={15} />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-stretch">
        <div className="flex w-[54px] flex-none flex-col items-center justify-center gap-2 border-r border-line-2">
          <button className="grid h-9 w-9 place-items-center rounded-full bg-ink text-on-ink" onClick={() => play()} disabled={Boolean(punch)} title="Play (Space)">
            {playing ? <Pause size={12} /> : <Play size={12} />}
          </button>
          <span className="font-mono text-[10.5px] text-muted">{fmtTenths(cursor)}</span>
        </div>
        <div ref={scroller} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden" onPointerDown={onPointerDown}
          onDoubleClick={(e) => {
            const t = T(e.clientX);
            const w = words.find((x) => t >= x.s - 0.05 && t <= x.e + 0.05);
            if (w) setSel(snap(w.s, w.e));
          }}
        >
          <div className="relative h-full" style={{ width: inner }}>
            {/* cues */}
            {Object.entries(info.marks).map(([name, t0]) => {
              const t = dragCue?.name === name ? dragCue.t : t0;
              return (
                <div key={name} className="absolute top-2 z-[3] flex -translate-x-1/2 cursor-ew-resize flex-col items-center" style={{ left: X(t) }} onPointerDown={(e) => dragMark(e, name)} title={`◆ ${name} · ${fmtTenths(t)} · drag to retime`}>
                  <span className="whitespace-nowrap rounded-[5px] px-1.5 text-[10.5px] font-semibold" style={{ background: "var(--color-cue-soft)", color: "var(--color-warn)" }}>
                    ◆ {name}
                  </span>
                  <i className="block h-[150px] w-0 border-l-[1.5px] border-dashed" style={{ borderColor: "var(--color-cue)" }} />
                </div>
              );
            })}
            {/* selection */}
            {sel && <div className="absolute bottom-6 top-7 z-[1] border-x-2 border-accent bg-accent/10" style={{ left: X(sel[0]), width: X(sel[1]) - X(sel[0]) }} />}
            {/* waveform */}
            <div className="absolute inset-x-0 top-9 h-[118px]" style={{ paddingLeft: 8, paddingRight: 8 }}>
              <BigWave peaks={peaks} sel={sel ? [sel[0] / duration, sel[1] / duration] : null} />
            </div>
            {/* words */}
            <div className="absolute inset-x-0 top-[160px] h-6">
              {shown.map((w, i) => (
                <span key={i} className="absolute whitespace-nowrap text-[12.5px] text-ink-2" style={{ left: X(w.s) }}>
                  {w.w}
                </span>
              ))}
              {!words.length && <span className="absolute left-3 text-[12px] text-faint">No words were recognised in this take.</span>}
            </div>
            {/* cursor */}
            <div className="pointer-events-none absolute bottom-5 top-7 z-[2] w-[2px] rounded" style={{ left: X(cursor) - 1, background: punch === "recording" ? "var(--color-rec)" : "var(--color-ink)" }} />
            {/* actions on the selection */}
            {sel && !busy && !punch && (
              <div
                className="absolute top-1 z-[4] flex -translate-x-1/2 gap-1 rounded-[10px] bg-ink p-1 shadow-2"
                style={{ left: Math.min(inner - 200, Math.max(200, (X(sel[0]) + X(sel[1])) / 2)) }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <FloatBtn onClick={() => play(sel[0], sel[1])}>
                  <Play size={10} /> Play
                </FloatBtn>
                <FloatBtn onClick={() => void run("Cutting…", () => studio.voice.editTake(props.projectId, props.sceneId, { type: "cut", start: sel[0], end: sel[1] }))}>✂ Cut</FloatBtn>
                <FloatBtn onClick={() => void punchIn()} style={{ color: "#ff8a8e" }}>
                  ● Re-record this bit
                </FloatBtn>
                <span className="self-center px-1 font-mono text-[10.5px] text-on-ink/60">{(sel[1] - sel[0]).toFixed(1)} s</span>
              </div>
            )}
          </div>
        </div>
        {punch && (
          <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: "color-mix(in srgb, var(--color-surface) 70%, transparent)" }}>
            <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-2">
              <i className={`block h-3 w-3 rounded-full bg-rec ${punch === "recording" ? "animate-pulse" : "opacity-40"}`} />
              <span className="text-[13.5px]">{punch === "preroll" ? "Listen… recording starts when the playback stops" : "Recording. Say the new words, then press Space."}</span>
              <button className="btn btn-sm btn-dark" onClick={() => finishPunch(true)} disabled={punch !== "recording"}>
                Done
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => finishPunch(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      {error && <div className="flex-none bg-bad-soft px-3.5 py-1.5 text-[12px] text-bad">{error}</div>}
    </div>
  );
}

function FloatBtn(props: { onClick: () => void; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <button className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 text-[12.5px] font-semibold text-on-ink hover:bg-white/15" style={props.style} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

/** Words that fit without overlapping their neighbours. */
function visibleWords(words: SpokenWord[], X: (t: number) => number): SpokenWord[] {
  const out: SpokenWord[] = [];
  let edge = -Infinity;
  for (const w of words) {
    const x = X(w.s);
    if (x < edge + 4) continue;
    out.push(w);
    edge = x + w.w.length * 7.2;
  }
  return out;
}

function BigWave(props: { peaks: number[] | null; sel: [number, number] | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = () => {
      const r = cv.getBoundingClientRect();
      if (!r.width) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
      const g = cv.getContext("2d")!;
      g.scale(dpr, dpr);
      const css = getComputedStyle(cv);
      const base = css.getPropertyValue("--color-rec").trim() || "#e5484d";
      const hi = css.getPropertyValue("--color-accent").trim() || "#4338ca";
      const peaks = props.peaks ?? [];
      const bar = 3;
      const n = Math.floor(r.width / bar);
      for (let i = 0; i < n && peaks.length; i++) {
        const f = i / n;
        const a = Math.floor(f * peaks.length);
        const b = Math.max(a + 1, Math.floor(((i + 1) / n) * peaks.length));
        let m = 0;
        for (let j = a; j < b && j < peaks.length; j++) m = Math.max(m, peaks[j]);
        const h = Math.max(1.5, m * r.height * 0.92);
        g.fillStyle = props.sel && f >= props.sel[0] && f <= props.sel[1] ? hi : base;
        g.fillRect(i * bar, (r.height - h) / 2, bar - 1, h);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [props.peaks, props.sel]);
  return <canvas ref={ref} className="h-full w-full" />;
}
