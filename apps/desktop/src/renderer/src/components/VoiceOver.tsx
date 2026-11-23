import { useEffect, useRef, useState } from "react";
import type { NarrationInfo, SceneMeta, TakeInfo, VoiceOption } from "@studio/shared";
import { errorMessage, studio } from "../lib/api";
import { fmt, segmentAt, usePlayer, type PlayerBus, type Segment } from "../lib/player";
import { plainScript, scriptCues, type NarrationData } from "../lib/useNarration";
import { MicSetup, RecordSession, type MicSettings } from "./Recorder";
import { ScriptText } from "./ScriptText";
import { Pause, Play, Trash } from "./Icons";

/**
 * The voice-over panel. Two separate ways to give the animation a voice:
 *  - Script & AI voice: write (or have the assistant write) a script per scene, then an AI voice
 *    on this computer reads it.
 *  - Record your voice: the animation plays scene by scene while the teacher reads; it holds at
 *    each cue until they tap Space. Takes are kept and can be cut and patched afterwards.
 */

export type VoiceMode = "ai" | "record";

const PACES = [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.2];

export function VoiceOver(props: {
  projectId: string;
  kind: "video" | "web";
  scenes: SceneMeta[];
  activeSceneId?: string;
  narration: NarrationData;
  bus: PlayerBus;
  /** The assistant is working (writing scripts, changing scenes). */
  busy: boolean;
  voiceSettings?: { voice: string; speed: number };
  onAsk: (text: string, sceneId?: string) => void;
  onSelectScene: (id: string) => void;
  mode: VoiceMode;
  onMode: (m: VoiceMode) => void;
  /** Open the take editor for a scene. */
  onEditTake: (sceneId: string) => void;
  mic: MicSettings;
  onMic: (s: MicSettings) => void;
  /** Scene being recorded right now. */
  recording: string | null;
  onRecording: (sceneId: string | null) => void;
}) {
  const { narration: n, bus } = props;
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voice, setVoice] = useState(props.voiceSettings?.voice ?? "");
  const [speed, setSpeed] = useState(props.voiceSettings?.speed ?? 1);
  const [working, setWorking] = useState<{ sceneId?: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [takes, setTakes] = useState<Record<string, TakeInfo[]>>({});
  const segments = usePlayer(bus, (s) => s.segments);
  const cues = usePlayer(bus, (s) => s.cues);
  const ready = usePlayer(bus, (s) => s.ready);
  const playing = usePlayer(bus, (s) => s.playing);
  const speaking = usePlayer(bus, (s) => captionAt(s.segments, s.time, n.infos));
  const playingScene = usePlayer(bus, (s) => (s.playing ? segmentAt(s.segments, s.time)?.id : undefined));

  useEffect(() => {
    void studio.voice.voices().then((v) => {
      setVoices(v);
      setVoice((cur) => cur || v[0]?.id || "");
    });
    return studio.voice.onProgress((m) => setWorking((w) => (w ? { ...w, message: m } : w)));
  }, []);

  // Recordings: which takes each scene has (to offer going back to one after an AI voice).
  const infoKey = props.scenes.map((s) => `${s.id}:${n.infos[s.id]?.audioUrl ?? ""}`).join("|");
  useEffect(() => {
    if (props.mode !== "record") return;
    let live = true;
    void Promise.all(props.scenes.map(async (s) => [s.id, await studio.voice.takes(props.projectId, s.id).catch(() => [])] as const)).then((list) => {
      if (live) setTakes(Object.fromEntries(list));
    });
    return () => {
      live = false;
    };
  }, [props.mode, props.projectId, infoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(sceneId: string | undefined, message: string, fn: () => Promise<void>) {
    setError(null);
    setWorking({ sceneId, message });
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setWorking(null);
    }
  }

  const opts = { voice, speed };
  const withScript = props.scenes.filter((s) => plainScript(n.scripts[s.id] ?? ""));
  const locked = Boolean(working) || props.busy || Boolean(props.recording);
  const segOf = (id: string) => segments.find((s) => s.id === id);

  function playScene(id: string) {
    const seg = segOf(id);
    if (!seg) return;
    if (playingScene === id) return bus.pause();
    props.onSelectScene(id);
    bus.seek(seg.start + 0.001);
    bus.play();
  }

  async function voiceScene(id: string) {
    const info = await studio.voice.generate(props.projectId, id, opts);
    n.patch(id, { info });
  }

  const askScripts = (rewrite: boolean) =>
    props.onAsk(
      `${rewrite ? "Rewrite" : "Write"} the narration for every scene: one natural script per scene in narration/<scene>.md, matched to the level of the class. ` +
        `Put {{mark:name}} cues before the words where animations should start, and add the matching wait calls in each scene (` +
        (props.kind === "video" ? 'self.wait_until("name")' : 'await scene.waitUntil("name")') +
        "). Keep the animations themselves as they are. Don't make the voice; I'll do that.",
    );

  // ------------------------------------------------------------------ recording a scene
  if (props.recording) {
    const scene = props.scenes.find((s) => s.id === props.recording);
    const seg = segOf(props.recording);
    if (scene && seg)
      return (
        <RecordSession
          key={scene.id}
          bus={bus}
          scene={seg}
          sceneNumber={props.scenes.indexOf(scene) + 1}
          script={n.scripts[scene.id] ?? ""}
          cues={cues.filter((c) => c.sceneId === scene.id).sort((a, b) => a.t - b.t)}
          settings={props.mic}
          onCancel={() => props.onRecording(null)}
          onDone={(pcm, marks) => {
            props.onRecording(null);
            void run(scene.id, "Listening to your take…", async () => {
              const info = await studio.voice.saveRecording(props.projectId, scene.id, pcm, { marks });
              n.patch(scene.id, { info });
            });
          }}
        />
      );
  }

  if (!props.scenes.length)
    return (
      <div className="grid h-full place-items-center p-8 text-center text-[13px] text-muted">
        {props.busy ? "The assistant is making the scenes. Voice-over comes after." : "Voice-over is added per scene. Make a scene first."}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-none border-b border-line-2 px-4 pb-3 pt-3">
        <div className="seg w-full">
          <button className="flex-1 justify-center" data-on={props.mode === "ai"} onClick={() => props.onMode("ai")}>
            ✦ Script & AI voice
          </button>
          <button className="flex-1 justify-center" data-on={props.mode === "record"} onClick={() => props.onMode("record")}>
            <i className="block h-2 w-2 rounded-full bg-rec" /> Record your voice
          </button>
        </div>

        {props.mode === "ai" ? (
          <div className="mt-3 grid grid-cols-1 gap-2.5">
            <div className="flex items-center gap-2 text-[12.5px]">
              <label className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="text-muted">Voice</span>
                <select value={voice} onChange={(e) => setVoice(e.target.value)} className="min-w-0 flex-1 cursor-pointer truncate rounded-md border border-line bg-surface px-1.5 py-1 text-ink outline-none">
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} · {v.description}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-none items-center gap-1.5">
                <span className="text-muted">Pace</span>
                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="cursor-pointer rounded-md border border-line bg-surface px-1.5 py-1 text-ink outline-none">
                  {PACES.map((s) => (
                    <option key={s} value={s}>
                      {s}×
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex gap-2">
              <button className="btn btn-sm flex-1" disabled={locked} onClick={() => askScripts(withScript.length > 0)} title="The assistant writes a script for each scene, with cues where the animations start">
                ✦ {withScript.length ? "Rewrite scripts" : "Write scripts with AI"}
              </button>
              <button
                className="btn btn-sm btn-accent flex-1"
                disabled={locked || !withScript.length || !voice}
                onClick={() =>
                  void run(undefined, "Voicing…", async () => {
                    for (const [i, s] of withScript.entries()) {
                      setWorking({ sceneId: s.id, message: `Voicing scene ${props.scenes.indexOf(s) + 1} (${i + 1} of ${withScript.length})…` });
                      await voiceScene(s.id);
                    }
                  })
                }
              >
                {withScript.length === 0
                  ? "Voice the scenes"
                  : withScript.length === props.scenes.length
                    ? props.scenes.length === 1
                      ? "Voice the scene"
                      : `Voice all ${withScript.length} scenes`
                    : `Voice ${withScript.length} scene${withScript.length === 1 ? "" : "s"}`}
              </button>
            </div>
            {props.busy && (
              <div className="flex items-center gap-2 text-[12px] text-ink-2">
                <span className="spinner" /> The assistant is working. Scripts appear here as it writes them.
              </div>
            )}
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-2">
            <MicSetup settings={props.mic} onChange={props.onMic} />
            <p className="m-0 text-[12px] leading-snug text-muted">
              Record a scene and the animation plays with you. {props.mic.holdAtCues ? "It waits at each ◆ cue until you press Space." : "Your words are matched to the ◆ cues afterwards."}
            </p>
          </div>
        )}
        {working && !working.sceneId && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-2">
            <span className="spinner" /> {working.message}
          </div>
        )}
        {error && <div className="mt-2 whitespace-pre-wrap rounded-lg bg-bad-soft px-2.5 py-1.5 text-[12px] text-bad">{error}</div>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <div className="flex flex-col gap-2.5">
          {props.scenes.map((s, i) => {
            const info = n.infos[s.id] ?? null;
            const script = n.scripts[s.id] ?? "";
            const seg = segOf(s.id);
            const sceneCues = cues.filter((c) => c.sceneId === s.id).map((c) => c.name);
            const unlinked = ready && seg ? scriptCues(script).filter((c) => !sceneCues.includes(c)) : [];
            return (
              <SceneCard
                key={s.id}
                scene={s}
                index={i}
                seg={seg}
                active={props.activeSceneId === s.id}
                playing={playing && playingScene === s.id}
                info={info}
                onSelect={() => props.onSelectScene(s.id)}
                onPlay={() => playScene(s.id)}
                working={working?.sceneId === s.id ? working.message : null}
              >
                {props.mode === "ai" ? (
                  <>
                    <ScriptText
                      value={script}
                      speaking={playingScene === s.id ? speaking : undefined}
                      placeholder={n.loaded ? "Write what the narrator says. Type { to add a cue." : "…"}
                      onSave={(text) => {
                        n.patch(s.id, { script: text });
                        void studio.voice.saveScript(props.projectId, s.id, text).then(() => studio.voice.info(props.projectId, s.id).then((info) => n.patch(s.id, { info })));
                      }}
                    />
                    {unlinked.length > 0 && (
                      <div className="mt-1.5 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px]" style={{ background: "var(--color-cue-soft)", color: "var(--color-warn)" }}>
                        <span className="min-w-0 flex-1">
                          {unlinked.map((c) => `◆ ${c}`).join(", ")} {unlinked.length === 1 ? "isn't" : "aren't"} linked to an animation yet.
                        </span>
                        <button
                          className="flex-none font-semibold underline underline-offset-2"
                          disabled={props.busy}
                          onClick={() =>
                            props.onAsk(
                              `In the scene "${s.title}", add waits for the cues ${unlinked.map((c) => `"${c}"`).join(", ")} from narration/${s.id}.md (${props.kind === "video" ? 'self.wait_until("name")' : 'await scene.waitUntil("name")'}) before the animations they introduce.`,
                              s.id,
                            )
                          }
                        >
                          Link with AI
                        </button>
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-1.5">
                      <button className="btn btn-sm" disabled={locked || !plainScript(script) || !voice} onClick={() => void run(s.id, "Making the voice…", () => voiceScene(s.id))}>
                        ✦ {info?.source === "ai" ? (info.stale ? "Update voice" : "Regenerate") : info ? "Use AI voice" : "AI voice"}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={props.busy}
                        onClick={() =>
                          props.onAsk(
                            plainScript(script)
                              ? `Improve the narration script for the scene "${s.title}" (narration/${s.id}.md): clearer and more natural to say aloud, same cues unless the animation needs others.`
                              : `Write the narration for the scene "${s.title}" in narration/${s.id}.md with {{mark:...}} cues where the animations should start, and add the matching waits in the scene. Don't make the voice.`,
                            s.id,
                          )
                        }
                      >
                        {plainScript(script) ? "Improve with AI" : "✦ Write with AI"}
                      </button>
                      <span className="flex-1" />
                      {info && (
                        <button
                          className="icon-btn h-7 w-7 hover:text-bad"
                          title="Remove the voice from this scene"
                          disabled={locked}
                          onClick={() =>
                            void run(s.id, "Removing…", async () => {
                              await studio.voice.remove(props.projectId, s.id);
                              n.patch(s.id, { info: null });
                            })
                          }
                        >
                          <Trash size={14} />
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <RecordActions
                    script={script}
                    info={info}
                    takes={takes[s.id] ?? []}
                    canRecord={Boolean(seg) && !locked}
                    whyNot={!seg ? (ready ? "This scene isn't in the preview yet." : "Waiting for the preview…") : null}
                    onRecord={() => {
                      props.onSelectScene(s.id);
                      props.onRecording(s.id);
                    }}
                    onEdit={() => props.onEditTake(s.id)}
                    onUseTake={(t) =>
                      void run(s.id, "Switching back to your recording…", async () => {
                        const info = await studio.voice.useTake(props.projectId, s.id, t.id);
                        n.patch(s.id, { info });
                      })
                    }
                    locked={locked}
                  />
                )}
              </SceneCard>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SceneCard(props: {
  scene: SceneMeta;
  index: number;
  seg?: Segment;
  active: boolean;
  playing: boolean;
  info: NarrationInfo | null;
  working: string | null;
  onSelect: () => void;
  onPlay: () => void;
  children: React.ReactNode;
}) {
  const { scene: s, info } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.active) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [props.active]);
  return (
    <div
      ref={ref}
      className="rounded-[12px] border bg-surface p-3 transition-shadow"
      style={props.active ? { borderColor: "var(--color-accent-line)", boxShadow: "0 0 0 1px var(--color-accent-line), var(--shadow-1)" } : { borderColor: "var(--color-line)" }}
      onClick={props.onSelect}
    >
      <div className="mb-1.5 flex items-center gap-2.5">
        <button
          className="group relative grid aspect-video w-[58px] flex-none place-items-center overflow-hidden rounded-md bg-stage bg-cover bg-center text-white"
          style={s.thumbUrl ? { backgroundImage: `url("${s.thumbUrl}")` } : undefined}
          onClick={(e) => {
            e.stopPropagation();
            props.onPlay();
          }}
          disabled={!props.seg}
          title={props.playing ? "Pause" : "Play this scene"}
        >
          <span className={`grid h-6 w-6 place-items-center rounded-full bg-black/55 transition-opacity ${props.playing ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
            {props.playing ? <Pause size={9} /> : <Play size={9} />}
          </span>
          <i className="absolute bottom-0.5 left-1 not-italic text-[10px] font-semibold [text-shadow:0_1px_3px_#000]">{props.index + 1}</i>
        </button>
        <div className="min-w-0 flex-1">
          <b className="block truncate text-[13px] font-semibold leading-tight">{s.title}</b>
          <span className="font-mono text-[11px] text-muted">{props.seg ? `${fmt(props.seg.start)} – ${fmt(props.seg.end)}` : "—"}</span>
        </div>
        <VoicePill info={info} />
      </div>
      <div onClick={(e) => e.stopPropagation()}>{props.children}</div>
      {props.working && (
        <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-2">
          <span className="spinner" /> {props.working}
        </div>
      )}
    </div>
  );
}

function VoicePill({ info }: { info: NarrationInfo | null }) {
  if (!info) return <span className="tag flex-none bg-soft text-faint">No voice</span>;
  if (info.stale)
    return (
      <span className="tag flex-none" style={{ background: "var(--color-warn-soft)", color: "var(--color-warn)" }} title="The script changed since this voice was made">
        Script changed
      </span>
    );
  const me = info.source === "recording";
  return (
    <span className="tag flex-none" style={me ? { background: "var(--color-rec-soft)", color: "var(--color-rec)" } : { background: "var(--color-voice-soft)", color: "var(--color-voice)" }}>
      <i className="block h-1.5 w-1.5 rounded-full" style={{ background: "currentColor" }} />
      {me ? `Your voice${info.take ? ` · take ${info.take.replace(/\D/g, "")}` : ""}` : "AI voice"} · {info.duration.toFixed(0)} s
    </span>
  );
}

function RecordActions(props: {
  script: string;
  info: NarrationInfo | null;
  takes: TakeInfo[];
  canRecord: boolean;
  whyNot: string | null;
  locked: boolean;
  onRecord: () => void;
  onEdit: () => void;
  onUseTake: (t: TakeInfo) => void;
}) {
  const text = plainScript(props.script);
  const mine = props.info?.source === "recording";
  const latest = props.takes[props.takes.length - 1];
  return (
    <>
      <p className="m-0 line-clamp-2 text-[12.5px] leading-[1.5] text-ink-2">{text || <span className="text-faint">No script. You can still record; say whatever fits the animation.</span>}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button className="btn btn-sm" disabled={!props.canRecord} onClick={props.onRecord} title={props.whyNot ?? "Record this scene"}>
          <i className="block h-2 w-2 rounded-full bg-rec" /> {props.takes.length ? "Record a new take" : "Record"}
        </button>
        {mine && (
          <button className="btn btn-sm" disabled={props.locked} onClick={props.onEdit}>
            ✂ Edit take
          </button>
        )}
        {!mine && latest && (
          <button className="btn btn-ghost btn-sm" disabled={props.locked} onClick={() => props.onUseTake(latest)}>
            Use take {latest.n} again
          </button>
        )}
      </div>
      {props.whyNot && <div className="mt-1.5 text-[11.5px] text-faint">{props.whyNot}</div>}
    </>
  );
}

/** The caption being spoken at time t, if that scene has a voice. Returns a string (stable). */
function captionAt(segments: Segment[], t: number, infos: Record<string, NarrationInfo | null>): string {
  const seg = segmentAt(segments, t);
  const info = seg && infos[seg.id];
  if (!seg || !info) return "";
  const local = t - seg.start;
  return info.captions.find((c) => local >= c.start && local < c.end)?.text ?? "";
}
