import { useEffect, useRef, useState } from "react";
import type { NarrationInfo, SceneMeta, VoiceOption } from "@studio/shared";
import { errorMessage, studio } from "../lib/api";

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
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Script text with {{mark:name}} shown as amber cue chips. */
function Teleprompter({ text }: { text: string }) {
  const parts = text.replace(/^\s*#.*$/gm, "").split(/(\{\{\s*mark\s*:\s*[\w-]+\s*\}\})/g);
  return (
    <div className="serif text-[19px] leading-[1.55] text-ink">
      {parts.map((p, i) => {
        const m = /\{\{\s*mark\s*:\s*([\w-]+)\s*\}\}/.exec(p);
        return m ? (
          <span key={i} className="mx-0.5 inline-flex items-center gap-1 rounded-full bg-warn-soft px-1.5 align-[2px] font-sans text-[10.5px] font-medium text-warn">
            <i className="h-[5px] w-[5px] rounded-full bg-[#E8A33D]" />
            {m[1]}
          </span>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </div>
  );
}

export function Narration(props: {
  projectId: string;
  scene?: SceneMeta;
  revision: number;
  voiceSettings?: { voice: string; speed: number };
  busy: boolean;
  onAsk: (text: string) => void;
}) {
  const sceneId = props.scene?.id;
  const [script, setScript] = useState("");
  const [savedScript, setSavedScript] = useState("");
  const [info, setInfo] = useState<NarrationInfo | null>(null);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voice, setVoice] = useState(props.voiceSettings?.voice ?? "af_heart");
  const [speed, setSpeed] = useState(props.voiceSettings?.speed ?? 1);
  const [source, setSource] = useState<"ai" | "recording">("ai");
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState<number[]>(Array(32).fill(0.1));
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stopMeter = useRef<() => void>(() => {});

  useEffect(() => {
    void studio.voice.voices().then(setVoices);
    return studio.voice.onProgress((m) => setWorking(m));
  }, []);

  useEffect(() => {
    if (!sceneId) return;
    void studio.voice.script(props.projectId, sceneId).then((t) => {
      setScript(t);
      setSavedScript(t);
    });
    void studio.voice.info(props.projectId, sceneId).then((i) => {
      setInfo(i);
      if (i) setSource(i.source);
    });
  }, [props.projectId, sceneId, props.revision]);

  async function saveScript() {
    if (!sceneId || script === savedScript) return;
    await studio.voice.saveScript(props.projectId, sceneId, script);
    setSavedScript(script);
  }

  async function run(fn: () => Promise<NarrationInfo | void>) {
    setError(null);
    setWorking("Working…");
    try {
      await saveScript();
      const r = await fn();
      if (r) setInfo(r);
      else if (sceneId) setInfo(await studio.voice.info(props.projectId, sceneId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking(null);
    }
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        stopMeter.current();
        const blob = new Blob(chunks.current, { type: rec.mimeType });
        void run(async () => studio.voice.saveRecording(props.projectId, sceneId!, await toPcm16k(blob)));
      };
      // Live level meter.
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let raf = 0;
      const tick = () => {
        analyser.getByteFrequencyData(data);
        setLevel(Array.from(data.slice(0, 32), (v) => 0.08 + v / 290));
        raf = requestAnimationFrame(tick);
      };
      tick();
      stopMeter.current = () => {
        cancelAnimationFrame(raf);
        void ctx.close();
        setLevel(Array(32).fill(0.1));
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch (e) {
      setError(`Could not use the microphone: ${errorMessage(e)}`);
    }
  }

  function stopRecording() {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  }

  if (!props.scene) return <div className="mt-6 text-center text-muted">Narration is written per scene. Create a scene first.</div>;
  const hasScript = /\S/.test(script.replace(/^\s*#.*$/gm, ""));

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12px] text-muted">
        Scene: <b className="font-medium text-ink-2">{props.scene.title}</b>
      </div>

      {recording ? (
        <div className="rounded-xl bg-surface p-3.5 shadow-1">
          <div className="eyebrow mb-1.5">Read aloud</div>
          <Teleprompter text={script} />
        </div>
      ) : (
        <div>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            onBlur={() => void saveScript()}
            rows={7}
            placeholder={"What should be said in this scene?\nPut {{mark:name}} before the word an animation should start on."}
            className="serif w-full resize-y rounded-xl bg-surface p-3 text-[16px] leading-[1.5] shadow-1 outline-none placeholder:font-sans placeholder:text-[12.5px] placeholder:text-faint focus:shadow-[0_0_0_2px_var(--color-accent)]"
          />
          <div className="mt-1 flex items-center gap-2 text-[11.5px] text-muted">
            <span className="flex-1">
              Cue an animation with <code className="rounded bg-warn-soft px-1 text-warn">{"{{mark:name}}"}</code>
            </span>
            <button className="btn btn-ghost btn-sm" disabled={props.busy} onClick={() => props.onAsk(hasScript ? "Polish the narration for this scene and make sure the sync marks match the animations." : "Write narration for this scene, with {{mark:...}} cues where the animations should start, and add matching waitUntil calls in the scene.")}>
              ✦ {hasScript ? "Polish with assistant" : "Write with assistant"}
            </button>
          </div>
        </div>
      )}

      <div className="seg self-start">
        <button data-on={source === "ai"} onClick={() => setSource("ai")} disabled={recording}>
          AI voice
        </button>
        <button data-on={source === "recording"} onClick={() => setSource("recording")} disabled={recording}>
          My voice
        </button>
      </div>

      {source === "ai" ? (
        <div className="rounded-xl bg-surface p-3 shadow-1">
          <div className="grid grid-cols-2 gap-1.5">
            {voices.map((v) => (
              <button
                key={v.id}
                onClick={() => setVoice(v.id)}
                className="rounded-[10px] px-2.5 py-2 text-left"
                style={voice === v.id ? { background: "var(--color-accent-soft)", boxShadow: "inset 0 0 0 1.5px var(--color-accent)" } : { background: "var(--color-surface-2)" }}
              >
                <b className="block text-[12.5px] font-medium">{v.label}</b>
                <small className="text-[11px] text-muted">{v.description}</small>
              </button>
            ))}
          </div>
          <label className="mt-2.5 flex items-center gap-2.5 text-[12px] text-ink-2">
            Pace
            <input type="range" min={0.8} max={1.2} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="flex-1 accent-[var(--color-accent)]" />
            <span className="w-9 font-mono">{speed.toFixed(2)}×</span>
          </label>
          <button className="btn btn-dark mt-2.5 w-full justify-center" disabled={!hasScript || !!working} onClick={() => void run(() => studio.voice.generate(props.projectId, sceneId!, { voice, speed }))}>
            {working ? <span className="spinner" /> : null}
            {working ?? (info?.source === "ai" ? "Regenerate voice" : "Generate voice")}
          </button>
          <p className="mb-0 mt-2 text-[11px] text-muted">Runs on this computer. Free, and nothing is uploaded.</p>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-xl bg-surface p-3 shadow-1">
          <button
            className="grid h-11 w-11 flex-none place-items-center rounded-full text-white"
            style={{ background: "var(--color-manim-red)", animation: recording ? "pulse-ring 1.3s infinite" : undefined }}
            disabled={!!working || !hasScript}
            onClick={() => (recording ? stopRecording() : void startRecording())}
            title={recording ? "Stop" : "Record"}
          >
            {recording ? <span className="block h-3.5 w-3.5 rounded-sm bg-white" /> : <span className="block h-3.5 w-3.5 rounded-full bg-white" />}
          </button>
          <div className="min-w-0 flex-1">
            <b className="text-[12.5px] font-semibold">{recording ? "Recording… read the script" : working ?? "Record this scene"}</b>
            <div className="mt-1 flex h-6 items-center gap-[2px]">
              {level.map((l, i) => (
                <i key={i} className="block flex-1 rounded-sm" style={{ height: `${Math.min(100, l * 100)}%`, background: recording ? "var(--color-manim-red)" : "#F3C2BC" }} />
              ))}
            </div>
            <small className="text-[11px] text-muted">Cues are matched to your words automatically.</small>
          </div>
        </div>
      )}

      {info && (
        <div className="rounded-xl bg-surface p-3 shadow-1 animate-in">
          <div className="mb-1.5 flex items-center gap-2 text-[12px]">
            <b className="font-semibold">{info.source === "ai" ? `AI voice · ${voices.find((v) => v.id === info.voice)?.label ?? info.voice}` : "Your recording"}</b>
            <span className="text-muted">{info.duration.toFixed(1)} s</span>
            <span className="flex-1" />
            <button className="text-[11.5px] text-muted hover:text-bad" onClick={() => void run(() => studio.voice.remove(props.projectId, sceneId!))}>
              Remove
            </button>
          </div>
          <audio controls src={info.audioUrl} className="h-8 w-full" />
          {Object.keys(info.marks).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(info.marks).map(([k, t]) => (
                <span key={k} className="chip bg-warn-soft text-warn">
                  {k} · {t.toFixed(1)}s
                </span>
              ))}
            </div>
          )}
          {info.stale && <div className="mt-2 rounded-lg bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">The script changed since this voice was made. Generate or record again to match.</div>}
        </div>
      )}
      {error && <div className="whitespace-pre-wrap rounded-lg bg-bad-soft px-2.5 py-1.5 text-[12px] text-bad">{error}</div>}
    </div>
  );
}
