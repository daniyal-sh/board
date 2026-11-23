import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/api";
import type { PlayerBus, Segment } from "../lib/player";
import { scriptParts } from "../lib/useNarration";

/** Decode a recording and resample it to 16 kHz mono (what speech recognition and takes use). */
export async function toPcm16k(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  await ctx.close();
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  return (await offline.startRendering()).getChannelData(0).slice();
}

export interface MicSettings {
  deviceId?: string;
  /** Hold each animation at its cue until the teacher taps Space. */
  holdAtCues: boolean;
  countIn: boolean;
}

const SETTINGS_KEY = "board.mic";
export function loadMicSettings(): MicSettings {
  try {
    return { holdAtCues: true, countIn: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return { holdAtCues: true, countIn: true };
  }
}
export function saveMicSettings(s: MicSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

/** A live microphone: the stream, a recorder and a loudness reading. */
export async function openMic(deviceId?: string) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  return {
    stream,
    /** Loudness right now, 0..1. */
    level() {
      analyser.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      return Math.min(1, Math.sqrt(s / buf.length) * 4.5);
    },
    close() {
      stream.getTracks().forEach((t) => t.stop());
      if (ctx.state !== "closed") void ctx.close().catch(() => {});
    },
  };
}
export type Mic = Awaited<ReturnType<typeof openMic>>;

/** Microphone picker with a live level meter. */
export function MicSetup(props: { settings: MicSettings; onChange: (s: MicSettings) => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const s = props.settings;

  useEffect(() => {
    let mic: Mic | null = null;
    let raf = 0;
    let live = true;
    setError(null);
    openMic(s.deviceId)
      .then(async (m) => {
        if (!live) return m.close();
        mic = m;
        setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"));
        const tick = () => {
          setLevel(m.level());
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch((e) => setError(`Can't use the microphone: ${errorMessage(e)}`));
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      mic?.close();
    };
  }, [s.deviceId]);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-2.5 rounded-xl border border-line bg-surface p-3 text-[12.5px]">
      <div className="flex items-center gap-2">
        <span className="text-muted">Microphone</span>
        <select
          className="w-0 min-w-0 flex-1 cursor-pointer truncate rounded-md border border-line bg-surface px-2 py-1 text-ink outline-none"
          value={s.deviceId ?? ""}
          onChange={(e) => props.onChange({ ...s, deviceId: e.target.value || undefined })}
        >
          <option value="">Default</option>
          {devices
            .filter((d) => d.deviceId && d.deviceId !== "default")
            .map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || "Microphone"}
              </option>
            ))}
        </select>
        <LevelMeter level={level} />
      </div>
      {error && <div className="rounded-md bg-bad-soft px-2 py-1.5 text-bad">{error}</div>}
      <label className="flex cursor-pointer items-start gap-2">
        <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={s.holdAtCues} onChange={(e) => props.onChange({ ...s, holdAtCues: e.target.checked })} />
        <span>
          <b className="font-medium text-ink">Hold the animation at each cue</b>
          <span className="block text-muted">Press Space when you say the word, and the animation goes on from there.</span>
        </span>
      </label>
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" className="accent-[var(--color-accent)]" checked={s.countIn} onChange={(e) => props.onChange({ ...s, countIn: e.target.checked })} />
        <span className="font-medium text-ink">3-second count-in</span>
      </label>
    </div>
  );
}

export function LevelMeter(props: { level: number; bars?: number }) {
  const n = props.bars ?? 12;
  return (
    <span className="flex h-4 flex-none items-end gap-[2px]" aria-label="Microphone level">
      {Array.from({ length: n }, (_, i) => {
        const on = props.level * n > i;
        return <i key={i} className="block w-[3px] rounded-[1px]" style={{ height: `${30 + (i / n) * 70}%`, background: on ? (i > n * 0.8 ? "var(--color-warn)" : "var(--color-good)") : "var(--color-line)" }} />;
      })}
    </span>
  );
}

type Phase = "starting" | "countdown" | "recording" | "paused" | "ending" | "saving" | "failed";

/**
 * Recording a scene through its animation. The animation plays from the start of the scene;
 * with "hold at cues" on, it stops at each cue until the teacher presses Space (which also
 * notes exactly when they said the cue word). The script scrolls along as a teleprompter.
 */
export function RecordSession(props: {
  bus: PlayerBus;
  scene: Segment;
  sceneNumber: number;
  script: string;
  /** Cues of this scene on the timeline, in order. */
  cues: { name: string; t: number }[];
  settings: MicSettings;
  onDone: (pcm: Float32Array, marks: Record<string, number>) => void;
  onCancel: () => void;
}) {
  const { bus, scene } = props;
  const [phase, setPhase] = useState<Phase>("starting");
  const [count, setCount] = useState(3);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [tapped, setTapped] = useState(0);
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mic = useRef<Mic | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const clock = useRef({ start: 0, pausedAt: 0, paused: 0 });
  const marks = useRef<Record<string, number>>({});
  const levels = useRef<number[]>([]);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const tappedRef = useRef(0);
  tappedRef.current = tapped;
  const parts = scriptParts(props.script);
  const cueNames = props.cues.length ? props.cues.map((c) => c.name) : parts.filter((p) => p.cue).map((p) => p.cue!);
  const nextCue = cueNames[tapped];
  const elapsed = () => {
    const c = clock.current;
    return (performance.now() - c.start - c.paused - (phaseRef.current === "paused" ? performance.now() - c.pausedAt : 0)) / 1000;
  };

  // Open the microphone, then count in.
  useEffect(() => {
    let live = true;
    // From now on the recorder owns the keys and the playhead (no loop, no timeline shortcuts).
    bus.set({ recording: true, live: { sceneId: scene.id, start: scene.start, seconds: 0, levels: [] } });
    bus.pause();
    bus.seek(scene.start + 0.001);
    openMic(props.settings.deviceId)
      .then((m) => {
        if (!live) return m.close();
        mic.current = m;
        setPhase(props.settings.countIn ? "countdown" : "recording");
      })
      .catch((e) => {
        setError(`Can't use the microphone: ${errorMessage(e)}`);
        setPhase("failed");
      });
    return () => {
      live = false;
      rec.current?.state !== "inactive" && rec.current?.stop();
      mic.current?.close();
      bus.set({ recording: false, live: null });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phase !== "countdown") return;
    if (count <= 0) {
      setPhase("recording");
      return;
    }
    const t = setTimeout(() => setCount((c) => c - 1), 800);
    return () => clearTimeout(t);
  }, [phase, count]);

  // Start recording and playing together.
  useEffect(() => {
    if (phase !== "recording" || rec.current || !mic.current) return;
    const r = new MediaRecorder(mic.current.stream);
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.start(250);
    rec.current = r;
    clock.current = { start: performance.now(), pausedAt: 0, paused: 0 };
    bus.pause();
    bus.seek(scene.start + 0.001);
    bus.play();
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Meter, clock and the live waveform on the timeline.
  useEffect(() => {
    if (phase !== "recording" && phase !== "ending") return;
    const iv = setInterval(() => {
      const l = mic.current?.level() ?? 0;
      setLevel(l);
      levels.current.push(l);
      const s = elapsed();
      setSeconds(s);
      bus.set({ live: { sceneId: scene.id, start: scene.start, seconds: s, levels: levels.current.slice() } });
    }, 100);
    return () => clearInterval(iv);
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hold at the next cue; stop the picture at the end of the scene.
  useEffect(
    () =>
      bus.subscribe(() => {
        if (phaseRef.current !== "recording") return;
        const st = bus.get();
        const cue = props.cues[tappedRef.current];
        if (props.settings.holdAtCues && cue && st.playing && st.time >= cue.t - 0.04) {
          bus.pause();
          bus.seek(cue.t);
          setHolding(true);
        } else if (st.playing && st.time >= scene.end - 0.06) {
          bus.pause();
          // Stay on the scene's last frame, not the first of the next one.
          bus.seek(Math.max(scene.start, scene.end - 0.05));
          setPhase("ending");
        }
      }),
    [bus, props.cues, props.settings.holdAtCues, scene.end],
  );
  function tapCue() {
    if (phase !== "recording" || !nextCue) return;
    marks.current[nextCue] = Number(elapsed().toFixed(3));
    const cue = props.cues[tapped];
    tappedRef.current = tapped + 1;
    setTapped((n) => n + 1);
    setHolding(false);
    if (cue && bus.get().time < cue.t) bus.seek(cue.t);
    bus.play();
  }

  function pause() {
    if (phase === "recording") {
      rec.current?.pause();
      bus.pause();
      clock.current.pausedAt = performance.now();
      setPhase("paused");
    } else if (phase === "paused") {
      rec.current?.resume();
      clock.current.paused += performance.now() - clock.current.pausedAt;
      setPhase("recording");
      if (!holding) bus.play();
    }
  }

  function stop() {
    const r = rec.current;
    if (!r || phase === "saving") return;
    setPhase("saving");
    bus.pause();
    r.onstop = async () => {
      try {
        const blob = new Blob(chunks.current, { type: r.mimeType });
        const pcm = await toPcm16k(blob);
        mic.current?.close();
        props.onDone(pcm, marks.current);
      } catch (e) {
        mic.current?.close();
        setError(`Couldn't save the take: ${errorMessage(e)}`);
        setPhase("failed");
      }
    };
    if (r.state === "paused") r.resume();
    r.stop();
  }

  // Space: I've reached the cue. Enter: finished. P or Escape: pause.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === " ") {
        e.preventDefault();
        tapCue();
      } else if (e.key === "Enter") {
        e.preventDefault();
        stop();
      } else if (e.key === "p" || e.key === "P" || e.key === "Escape") {
        e.preventDefault();
        pause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Keep the current line in view.
  const prompter = useRef<HTMLDivElement>(null);
  useEffect(() => {
    prompter.current?.querySelector("[data-current]")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [tapped]);

  // Which part of the script is being read: the one before the next cue to tap.
  const nextPart = nextCue ? parts.findIndex((p) => p.cue === nextCue) : -1;
  const partIndex = nextPart > 0 ? nextPart - 1 : nextCue ? Math.min(parts.length - 1, tapped) : parts.length - 1;
  const mm = `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${Math.floor((seconds % 1) * 10)}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex flex-none items-center gap-2.5 border-b px-4 py-2.5 text-[13px]"
        style={{ background: "var(--color-rec-soft)", borderColor: "color-mix(in srgb, var(--color-rec) 25%, transparent)" }}
      >
        <i className={`block h-2.5 w-2.5 rounded-full bg-rec ${phase === "recording" ? "animate-pulse" : ""}`} />
        <b className="text-rec">{phase === "countdown" || phase === "starting" ? "Get ready" : phase === "paused" ? "Paused" : phase === "saving" ? "Saving" : phase === "failed" ? "Stopped" : "Recording"}</b>
        <span className="font-mono tabular-nums text-ink">{mm}</span>
        <span className="min-w-0 truncate text-muted">
          · Scene {props.sceneNumber} · {scene.title}
        </span>
        <span className="flex-1" />
        <LevelMeter level={level} bars={10} />
      </div>

      <div ref={prompter} className="relative min-h-0 flex-1 overflow-auto px-6 py-6">
        {(phase === "countdown" || phase === "starting") && !error && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-surface/80 backdrop-blur-[2px]">
            <div className="text-center">
              <div className="font-semibold tabular-nums text-ink" style={{ fontSize: 88, lineHeight: 1 }}>
                {phase === "starting" ? "…" : Math.max(1, count)}
              </div>
              <div className="mt-2 text-[13px] text-muted">The animation starts with you</div>
            </div>
          </div>
        )}
        <div className="text-[25px] font-medium leading-[1.6]">
          {parts.map((p, i) => (
            <span key={i} data-current={i === partIndex ? "" : undefined} className={i < partIndex ? "text-faint/70" : i === partIndex ? "text-ink" : "text-faint"}>
              {p.cue && (
                <span
                  className="mx-1 inline-flex h-[30px] items-center gap-1.5 rounded-lg px-2.5 align-[3px] text-[14px] font-bold"
                  style={
                    p.cue === nextCue && phase !== "ending"
                      ? { background: "var(--color-cue)", color: "#1d1300", boxShadow: "0 0 0 4px color-mix(in srgb, var(--color-cue) 25%, transparent)" }
                      : { background: "var(--color-cue-soft)", color: "var(--color-warn)" }
                  }
                >
                  ◆ {p.cue}
                </span>
              )}{" "}
              {p.text}{" "}
            </span>
          ))}
          {!parts.some((p) => p.text) && <span className="text-faint">This scene has no script. Say whatever fits the animation.</span>}
        </div>
      </div>

      <div className="flex-none border-t border-line-2 px-4 py-3">
        {error ? (
          <div className="mb-2 rounded-lg bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</div>
        ) : holding ? (
          <div className="mb-2.5 flex items-center gap-2 rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--color-cue-soft)", color: "var(--color-warn)" }}>
            <i className="block h-2.5 w-2.5 rotate-45 rounded-[2px]" style={{ background: "var(--color-cue)" }} />
            <span>
              Waiting for <b>“{nextCue}”</b>. Press <span className="kbd">Space</span> when you say it.
            </span>
          </div>
        ) : phase === "ending" ? (
          <div className="mb-2.5 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-2">
            That's the end of the scene. Press <span className="kbd">Enter</span> or <b>Done</b> when you finish speaking.
          </div>
        ) : nextCue && phase === "recording" ? (
          <div className="mb-2.5 text-[12.5px] text-muted">
            Next cue: <b className="text-warn">◆ {nextCue}</b> · press <span className="kbd">Space</span> as you say it
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <button className="btn btn-sm" onClick={props.onCancel} disabled={phase === "saving" && !error}>
            Discard
          </button>
          <span className="flex-1" />
          {nextCue && (phase === "recording" || phase === "paused") && (
            <button className="btn btn-sm" onClick={tapCue} disabled={phase !== "recording"}>
              ◆ {nextCue} <span className="kbd">Space</span>
            </button>
          )}
          <button className="btn btn-sm" onClick={pause} disabled={phase !== "recording" && phase !== "paused"}>
            {phase === "paused" ? "Resume" : "Pause"}
          </button>
          <button className="btn btn-sm btn-dark" onClick={stop} disabled={phase !== "recording" && phase !== "paused" && phase !== "ending"}>
            {phase === "saving" ? <span className="spinner" style={{ borderColor: "currentColor", borderRightColor: "transparent", width: 12, height: 12 }} /> : <span className="block h-2.5 w-2.5 rounded-[2px] bg-current" />}
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
