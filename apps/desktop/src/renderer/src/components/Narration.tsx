import { useEffect, useRef, useState } from "react";
import type { NarrationInfo, SceneMeta, VoiceOption } from "@studio/shared";
import { errorMessage, studio } from "../lib/api";
import { Close, Pause, Play } from "./Icons";

/** Decode a recording and resample it to 16 kHz mono for speech recognition. */
async function toPcm16k(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  await ctx.close();
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  return (await offline.startRendering()).getChannelData(0).slice();
}

const MARK = /(\{\{\s*mark\s*:\s*[\w-]+\s*\}\})/g;
const plain = (s: string) => s.replace(/^\s*#.*$/gm, "").replace(MARK, "").replace(/\s+/g, " ").trim();

/** Script with {{mark:…}} cues shown as small amber dots. */
function Script({ text, large }: { text: string; large?: boolean }) {
  return (
    <span className={large ? "serif text-[26px] leading-[1.5] text-ink" : ""}>
      {text
        .replace(/^\s*#.*$/gm, "")
        .split(MARK)
        .map((p, i) => {
          const m = /\{\{\s*mark\s*:\s*([\w-]+)\s*\}\}/.exec(p);
          return m ? (
            <span key={i} title={`Cue: ${m[1]}`} className={`mx-0.5 inline-block rounded-full bg-[#E8A33D] align-middle ${large ? "h-2.5 w-2.5" : "h-1.5 w-1.5"}`} />
          ) : (
            <span key={i}>{p}</span>
          );
        })}
    </span>
  );
}

/** One shared player for the whole panel. */
let player: HTMLAudioElement | null = null;

export function Narration(props: {
  projectId: string;
  kind: "video" | "web";
  scenes: SceneMeta[];
  activeSceneId?: string;
  revision: number;
  voiceSettings?: { voice: string; speed: number };
  busy: boolean;
  onAsk: (text: string, sceneId?: string) => void;
  onSelectScene: (id: string) => void;
}) {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voice, setVoice] = useState(props.voiceSettings?.voice ?? "af_heart");
  const [speed, setSpeed] = useState(props.voiceSettings?.speed ?? 1);
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [infos, setInfos] = useState<Record<string, NarrationInfo | null>>({});
  const [working, setWorking] = useState<{ sceneId?: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState<SceneMeta | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    void studio.voice.voices().then(setVoices);
    return studio.voice.onProgress((m) => setWorking((w) => (w ? { ...w, message: m } : w)));
  }, []);

  async function reload() {
    const s: Record<string, string> = {};
    const n: Record<string, NarrationInfo | null> = {};
    await Promise.all(
      props.scenes.map(async (sc) => {
        s[sc.id] = await studio.voice.script(props.projectId, sc.id);
        n[sc.id] = await studio.voice.info(props.projectId, sc.id);
      }),
    );
    setScripts(s);
    setInfos(n);
  }
  useEffect(() => {
    void reload();
  }, [props.projectId, props.revision, props.scenes.map((s) => s.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => player?.pause(), []);

  async function run(sceneId: string | undefined, message: string, fn: () => Promise<unknown>) {
    setError(null);
    setWorking({ sceneId, message });
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking(null);
      await reload();
    }
  }

  const withScript = props.scenes.filter((s) => plain(scripts[s.id] ?? ""));
  const opts = { voice, speed };

  function play(sceneId: string) {
    const info = infos[sceneId];
    if (!info) return;
    if (playing === sceneId) {
      player?.pause();
      setPlaying(null);
      return;
    }
    player?.pause();
    player = new Audio(info.audioUrl);
    player.onended = () => setPlaying(null);
    void player.play();
    setPlaying(sceneId);
  }

  if (!props.scenes.length) return <div className="mt-8 text-center text-[13px] text-muted">Narration is added per scene. Create a scene first.</div>;

  return (
    <div className="flex flex-col gap-4">
      {/* Whole video */}
      <div className="rounded-2xl bg-surface p-3.5 shadow-1">
        {withScript.length === 0 ? (
          <button
            className="btn btn-dark w-full justify-center py-2.5"
            disabled={props.busy || Boolean(working)}
            onClick={() => void run(undefined, "The assistant is writing the narration…", () => studio.voice.autoNarrate(props.projectId, opts))}
          >
            ✦ Narrate the whole {props.kind === "video" ? "video" : "animation"}
          </button>
        ) : (
          <button
            className="btn btn-dark w-full justify-center py-2.5"
            disabled={props.busy || Boolean(working)}
            onClick={() =>
              void run(undefined, "Voicing scenes…", async () => {
                for (const [i, s] of withScript.entries()) {
                  setWorking({ sceneId: s.id, message: `Voicing “${s.title}” (${i + 1} of ${withScript.length})…` });
                  await studio.voice.generate(props.projectId, s.id, opts);
                }
              })
            }
          >
            Voice all scenes with AI
          </button>
        )}
        <div className="mt-2.5 flex items-center gap-2 text-[12px] text-ink-2">
          <label className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="text-muted">Voice</span>
            <select value={voice} onChange={(e) => setVoice(e.target.value)} className="min-w-0 flex-1 cursor-pointer rounded-md bg-surface-2 px-1.5 py-1 outline-none">
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.description}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-muted">Pace</span>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="cursor-pointer rounded-md bg-surface-2 px-1.5 py-1 outline-none">
              {[0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.2].map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mb-0 mt-2 text-[11.5px] leading-snug text-muted">
          {withScript.length === 0
            ? "The assistant writes a script for each scene with cues for the animations, then an AI voice reads it. Runs on this computer, free."
            : "Uses each scene's script below. Scenes re-time themselves to the voice."}
          {withScript.length > 0 && (
            <>
              {" "}
              <button className="underline decoration-line underline-offset-2 hover:text-ink" disabled={props.busy || Boolean(working)} onClick={() => void run(undefined, "The assistant is rewriting the narration…", () => studio.voice.autoNarrate(props.projectId, opts))}>
                Rewrite all scripts
              </button>
            </>
          )}
        </p>
        {working && !working.sceneId && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-2">
            <span className="spinner" /> {working.message}
          </div>
        )}
      </div>

      {/* Per scene */}
      <div className="flex flex-col gap-2">
        {props.scenes.map((s, i) => {
          const script = scripts[s.id] ?? "";
          const info = infos[s.id];
          const busyHere = working?.sceneId === s.id;
          const active = props.activeSceneId === s.id;
          return (
            <div
              key={s.id}
              className="rounded-xl bg-surface p-3 shadow-1 transition"
              style={active ? { boxShadow: "0 0 0 1.5px var(--color-accent), var(--shadow-1)" } : undefined}
              onClick={() => props.onSelectScene(s.id)}
            >
              <div className="flex items-center gap-2">
                <span className="grid h-5 w-5 flex-none place-items-center rounded-md bg-stage font-mono text-[10px] text-white/80">{i + 1}</span>
                <b className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{s.title}</b>
                {info ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      play(s.id);
                    }}
                    className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={info.stale ? { background: "var(--color-warn-soft)", color: "var(--color-warn)" } : { background: "var(--color-good-soft)", color: "var(--color-good)" }}
                    title={info.stale ? "The script changed since this was made" : "Play"}
                  >
                    {playing === s.id ? <Pause size={9} /> : <Play size={9} />}
                    {info.source === "ai" ? "AI" : "Recorded"} · {info.duration.toFixed(1)}s{info.stale ? " · out of date" : ""}
                  </button>
                ) : (
                  <span className="text-[11px] text-faint">No voice</span>
                )}
              </div>

              {editing === s.id ? (
                <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                  <textarea
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={5}
                    className="serif w-full resize-y rounded-lg bg-surface-2 p-2.5 text-[15px] leading-[1.5] outline-none focus:shadow-[0_0_0_2px_var(--color-accent)]"
                  />
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                    <span className="flex-1">
                      Cue an animation with <code className="rounded bg-warn-soft px-1 text-warn">{"{{mark:name}}"}</code>
                    </span>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button
                      className="btn btn-dark btn-sm"
                      onClick={async () => {
                        await studio.voice.saveScript(props.projectId, s.id, draft);
                        setEditing(null);
                        await reload();
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : plain(script) ? (
                <button
                  className="mt-1.5 line-clamp-3 w-full text-left text-[12.5px] leading-[1.5] text-ink-2 hover:text-ink"
                  title="Edit script"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDraft(script);
                    setEditing(s.id);
                  }}
                >
                  <Script text={script} />
                </button>
              ) : (
                <div className="mt-1.5 text-[12px] text-muted">
                  <button
                    className="font-medium text-accent hover:underline"
                    disabled={props.busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onAsk(
                        `Write narration for the scene "${s.title}" in narration/${s.id}.md with {{mark:...}} cues where the animations should start, and add the matching waits in the scene.`,
                        s.id,
                      );
                    }}
                  >
                    ✦ Write with assistant
                  </button>
                  <span> or </span>
                  <button
                    className="font-medium text-ink-2 hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDraft("");
                      setEditing(s.id);
                    }}
                  >
                    write it yourself
                  </button>
                </div>
              )}

              {plain(script) && editing !== s.id && (
                <div className="mt-2 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="btn btn-sm"
                    disabled={Boolean(working) || props.busy}
                    onClick={() => void run(s.id, "Generating voice…", () => studio.voice.generate(props.projectId, s.id, opts))}
                  >
                    ✦ {info?.source === "ai" ? "Regenerate AI voice" : "AI voice"}
                  </button>
                  <button className="btn btn-sm" disabled={Boolean(working) || props.busy} onClick={() => setRecording(s)}>
                    <span className="block h-2 w-2 rounded-full bg-manim-red" /> {info?.source === "recording" ? "Record again" : "Record"}
                  </button>
                  <span className="flex-1" />
                  {info && (
                    <button className="text-[11px] text-faint hover:text-bad" disabled={Boolean(working)} onClick={() => void run(s.id, "Removing…", () => studio.voice.remove(props.projectId, s.id))}>
                      Remove
                    </button>
                  )}
                </div>
              )}
              {busyHere && (
                <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-2">
                  <span className="spinner" /> {working!.message}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <div className="whitespace-pre-wrap rounded-lg bg-bad-soft px-2.5 py-1.5 text-[12px] text-bad">{error}</div>}

      {recording && (
        <RecordSheet
          scene={recording}
          script={scripts[recording.id] ?? ""}
          onClose={() => setRecording(null)}
          onSave={(pcm) => {
            const s = recording;
            setRecording(null);
            void run(s.id, "Matching your words to the cues…", () => studio.voice.saveRecording(props.projectId, s.id, pcm));
          }}
        />
      )}
    </div>
  );
}

/** Focused recording: teleprompter, record, listen back, then keep or retake. */
function RecordSheet(props: { scene: SceneMeta; script: string; onClose: () => void; onSave: (pcm: Float32Array) => void }) {
  const [state, setState] = useState<"ready" | "recording" | "review">("ready");
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState<number[]>(Array(40).fill(0.08));
  const [take, setTake] = useState<{ blob: Blob; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const cleanup = useRef<() => void>(() => {});

  useEffect(() => () => cleanup.current(), []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && state !== "recording" && props.onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [state, props]);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const chunks: Blob[] = [];
      const r = new MediaRecorder(stream);
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        const blob = new Blob(chunks, { type: r.mimeType });
        setTake({ blob, url: URL.createObjectURL(blob) });
        setState("review");
      };
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let raf = 0;
      const t0 = Date.now();
      const tick = () => {
        analyser.getByteFrequencyData(data);
        setLevel(Array.from(data.slice(0, 40), (v) => 0.08 + v / 300));
        setSeconds((Date.now() - t0) / 1000);
        raf = requestAnimationFrame(tick);
      };
      tick();
      cleanup.current = () => {
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      };
      r.start();
      rec.current = r;
      setState("recording");
    } catch (e) {
      setError(`Could not use the microphone: ${errorMessage(e)}`);
    }
  }

  function stop() {
    rec.current?.stop();
    cleanup.current();
    setLevel(Array(40).fill(0.08));
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(23,23,28,.4)] backdrop-blur-[3px]">
      <div className="flex max-h-[86vh] w-[min(760px,92vw)] flex-col rounded-[22px] bg-surface p-6 shadow-[0_30px_80px_-20px_rgba(0,0,0,.55)] animate-in">
        <div className="mb-4 flex items-center">
          <div>
            <div className="eyebrow">Record narration</div>
            <h3 className="serif m-0 text-[24px]">{props.scene.title}</h3>
          </div>
          <span className="flex-1" />
          <button className="icon-btn" onClick={props.onClose} disabled={state === "recording"} aria-label="Close">
            <Close />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-2xl bg-surface-2 px-7 py-6">
          <Script text={props.script} large />
        </div>

        <div className="mt-5 flex items-center gap-4">
          {state === "review" && take ? (
            <>
              <audio controls src={take.url} className="h-9 flex-1" />
              <button
                className="btn"
                onClick={() => {
                  setTake(null);
                  setSeconds(0);
                  setState("ready");
                }}
              >
                Record again
              </button>
              <button className="btn btn-dark" onClick={async () => props.onSave(await toPcm16k(take.blob))}>
                Use this take
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => (state === "recording" ? stop() : void start())}
                className="grid h-14 w-14 flex-none place-items-center rounded-full text-white shadow-[0_8px_20px_-8px_rgba(242,107,91,.9)]"
                style={{ background: "var(--color-manim-red)", animation: state === "recording" ? "pulse-ring 1.3s infinite" : undefined }}
                aria-label={state === "recording" ? "Stop" : "Record"}
              >
                {state === "recording" ? <span className="block h-4 w-4 rounded-[3px] bg-white" /> : <span className="block h-4 w-4 rounded-full bg-white" />}
              </button>
              <div className="flex h-10 flex-1 items-center gap-[3px]">
                {level.map((l, i) => (
                  <i key={i} className="block flex-1 rounded-sm" style={{ height: `${Math.min(100, l * 100)}%`, background: state === "recording" ? "var(--color-manim-red)" : "var(--color-line)" }} />
                ))}
              </div>
              <span className="w-12 text-right font-mono text-[13px] text-ink-2">
                {Math.floor(seconds / 60)}:{String(Math.floor(seconds % 60)).padStart(2, "0")}
              </span>
            </>
          )}
        </div>
        <p className="mb-0 mt-3 text-[12px] text-muted">
          {state === "ready" && "Press record and read the script at your own pace. The amber dots are where animations start; you don't need to pause for them."}
          {state === "recording" && "Recording… press stop when you're done."}
          {state === "review" && "Listen back. When you keep it, your words are matched to the cues and the scene re-times itself."}
        </p>
        {error && <div className="mt-2 rounded-lg bg-bad-soft px-3 py-2 text-[12px] text-bad">{error}</div>}
      </div>
    </div>
  );
}
