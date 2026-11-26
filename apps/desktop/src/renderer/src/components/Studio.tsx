import { useEffect, useMemo, useRef, useState } from "react";
import { ASPECTS, PROJECT_KINDS, SLIDES_ENGINES, animationKind, type AgentRequest, type ProviderStatus, type SceneMeta, type Selection } from "@studio/shared";
import { errorMessage, studio } from "../lib/api";
import { useProject } from "../lib/useProject";
import { createPlayerBus, segmentAt, type Step } from "../lib/player";
import { useNarration } from "../lib/useNarration";
import { Chat } from "./Chat";
import { HistoryMenu } from "./HistoryMenu";
import { WebPreview } from "./WebPreview";
import { VideoStage } from "./VideoStage";
import { WebStage } from "./WebStage";
import { SlidesStage } from "./SlidesStage";
import { ExportDialog } from "./ExportDialog";
import { Timeline } from "./Timeline";
import { TakeEditor } from "./TakeEditor";
import { VoiceOver, type VoiceMode } from "./VoiceOver";
import { loadMicSettings, saveMicSettings, type MicSettings } from "./Recorder";
import { BoardMark } from "./Brand";
import { Back, ChatIcon, Download, Moon, Sun } from "./Icons";

const LAYOUT_KEY = "board.layout";
const DEFAULT_LAYOUT = { right: 360, voice: 400 };
const LIMITS = { right: [300, 680], voice: [340, 640] } as const;
type Side = keyof typeof DEFAULT_LAYOUT;

function loadLayout(): typeof DEFAULT_LAYOUT {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}");
    return { right: Number(saved.right) || DEFAULT_LAYOUT.right, voice: Number(saved.voice) || DEFAULT_LAYOUT.voice };
  } catch {
    return DEFAULT_LAYOUT;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** A thin drag handle between panels, like an IDE. Double-click resets. */
function Splitter(props: { onDrag: (dx: number) => void; onReset: () => void }) {
  return (
    <div className="relative z-10">
      <div
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize · double-click to reset"
        onDoubleClick={props.onReset}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          let x = e.clientX;
          const move = (ev: PointerEvent) => {
            props.onDrag(ev.clientX - x);
            x = ev.clientX;
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            document.body.style.cursor = "";
          };
          document.body.style.cursor = "col-resize";
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
        className="group absolute inset-y-0 -left-[3px] w-[6px] cursor-col-resize"
      >
        <div className="mx-auto h-full w-px bg-line transition-colors group-hover:w-[2px] group-hover:bg-accent group-active:w-[2px] group-active:bg-accent" />
      </div>
    </div>
  );
}

/** Projects whose first prompt has been sent (guards against React StrictMode double effects). */
const kickedOff = new Set<string>();
const voicedScript = new Set<string>();

/** Slides add "deck": the deck as presented. "edit" is the animation timeline. */
type Mode = "deck" | "edit" | "voice";

export function Studio(props: {
  projectId: string;
  firstPrompt?: string;
  intro?: AgentRequest["intro"];
  providers: ProviderStatus[] | null;
  dark: boolean;
  onToggleTheme: () => void;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const p = useProject(props.projectId);
  const bus = useMemo(createPlayerBus, [props.projectId]);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [layout, setLayout] = useState(loadLayout);
  const [mode, setMode] = useState<Mode>("deck");
  const [voiceMode, setVoiceMode] = useState<VoiceMode>(() => (read("board.voiceMode") === "record" ? "record" : "ai"));
  const [mic, setMic] = useState<MicSettings>(loadMicSettings);
  const [recording, setRecording] = useState<string | null>(null);
  const [editingTake, setEditingTake] = useState<string | null>(null);
  /** The assistant panel: open by default while editing, closed by default during voice-over. */
  const [chatOpen, setChatOpen] = useState(() => read("board.assistant") !== "0");
  const [chatInVoice, setChatInVoice] = useState(false);
  const showChat = mode === "voice" ? chatInVoice : chatOpen;
  const toggleChat = () => {
    if (mode === "voice") return setChatInVoice((o) => !o);
    setChatOpen((o) => {
      store("board.assistant", o ? "0" : "1");
      return !o;
    });
  };
  const resize = (side: Side, dx: number) =>
    setLayout((l) => {
      const next = { ...l, [side]: Math.min(LIMITS[side][1], Math.max(LIMITS[side][0], l[side] + dx)) };
      store(LAYOUT_KEY, JSON.stringify(next));
      return next;
    });
  const resetSide = (side: Side) => resize(side, DEFAULT_LAYOUT[side] - layout[side]);

  const manifest = p.project?.manifest;
  const allScenes = manifest?.scenes ?? [];
  const isLab = manifest?.kind === "lab";
  const isSlides = manifest?.kind === "slides";
  const anim = manifest ? animationKind(manifest) : null;
  // Slides: the timeline and the voice-over are about the animated slides only.
  const animScenes = useMemo(() => (isSlides ? allScenes.filter((s) => s.slideType !== "html") : allScenes), [isSlides, allScenes]);
  const deckMode = isSlides && mode === "deck";
  const scenes = deckMode ? allScenes : animScenes;
  const activeScene = scenes.find((s) => s.id === sceneId) ?? scenes[0];
  const narration = useNarration(props.projectId, animScenes, p.revision, Boolean(manifest) && !isLab);
  // While recording, the stage keeps what it shows: a rebuild would pull the scene out from under the take.
  const frozenStage = useRef({ revision: p.revision, busy: p.busy });
  if (!recording) frozenStage.current = { revision: p.revision, busy: p.busy };
  const stageRevision = frozenStage.current.revision;
  const stageBusy = frozenStage.current.busy;

  // Send the prompt the project was created with.
  useEffect(() => {
    if (!props.firstPrompt || !p.project || kickedOff.has(props.projectId)) return;
    kickedOff.add(props.projectId);
    if (p.project.chat.length === 0) void p.send(props.firstPrompt, { intro: props.intro });
  }, [props.firstPrompt, props.projectId, p.project, p.send]);

  // Started from a script: once the assistant has built the scenes, voice the script.
  const [voicing, setVoicing] = useState<string | null>(null);
  const firstTurn = p.turns[0];
  useEffect(() => {
    if (!props.intro?.script || firstTurn?.status !== "done" || voicedScript.has(props.projectId)) return;
    voicedScript.add(props.projectId);
    const off = studio.voice.onProgress(setVoicing);
    setVoicing("Voicing your script…");
    void (async () => {
      try {
        const saved = p.project?.manifest.voice;
        const voiceId = saved?.voice ?? (await studio.voice.voices())[0]?.id;
        if (voiceId) await studio.voice.autoNarrate(props.projectId, { voice: voiceId, speed: saved?.speed ?? 1, scriptsReady: true });
      } catch (e) {
        p.setError(errorMessage(e));
      } finally {
        off();
        setVoicing(null);
        void p.refresh();
      }
    })();
  }, [firstTurn?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the agent tools informed about the selection.
  useEffect(() => {
    void studio.agents.setSelection(props.projectId, selection);
  }, [props.projectId, selection]);

  // Only Slides have the deck view.
  useEffect(() => {
    if (manifest && !isSlides && mode === "deck") setMode("edit");
  }, [manifest?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving voice-over stops any recording and closes the take editor.
  useEffect(() => {
    if (mode !== "voice") {
      setRecording(null);
      setEditingTake(null);
    }
  }, [mode]);
  // The take editor only makes sense for a scene with a recording in use.
  const takeInfo = editingTake ? narration.infos[editingTake] : null;
  useEffect(() => {
    if (editingTake && narration.loaded && takeInfo?.source !== "recording") setEditingTake(null);
  }, [editingTake, narration.loaded, takeInfo?.source]);

  const thumbs = useMemo(() => Object.fromEntries(animScenes.map((s) => [s.id, s.thumbUrl])), [animScenes]);

  if (!p.project || !manifest) {
    return (
      <div className="grid h-full place-items-center text-muted">
        {p.error ? <div className="text-bad">{p.error}</div> : <div className="spinner" />}
      </div>
    );
  }

  const rename = async (value: string) => {
    setRenaming(false);
    if (value.trim() && value !== manifest.title) {
      await studio.projects.rename(manifest.id, value);
      await p.refresh();
    }
  };

  const ask = (text: string, sId?: string) => {
    void p.send(text, { selection: selection ?? undefined, sceneId: sId ?? activeScene?.id });
    setSelection(null);
  };

  const askStep = (step: Step) => {
    const scene = scenes.find((s) => s.id === step.sceneId);
    const seg = segmentAt(bus.get().segments, step.start + 0.001);
    setSelection({
      part: step.label,
      kind: "animation",
      sceneId: step.sceneId,
      time: seg ? Math.max(0, step.start - seg.start) : step.start,
      source: scene ? { file: scene.file, line: step.line ?? undefined } : undefined,
    });
    if (mode === "voice") setChatInVoice(true);
    else if (!chatOpen) toggleChat();
  };

  const locked = Boolean(recording);
  const picker = !isLab && scenes.length > 0 && !locked ? <ScenePicker scenes={scenes} active={activeScene} onPick={setSceneId} vertical={manifest.aspect === "vertical"} /> : null;
  const sceneNumber = (id: string) => scenes.findIndex((s) => s.id === id) + 1;

  const columns = [
    "minmax(0,1fr)",
    mode === "voice" ? "0px" : null,
    mode === "voice" ? `${layout.voice}px` : null,
    "0px",
    showChat ? `${layout.right}px` : "0px",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="grid h-full grid-rows-[52px_minmax(0,1fr)]">
      <header className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-line bg-surface px-3.5" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
        <div className="flex min-w-0 items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button className="icon-btn flex-none" title="Back to home" onClick={props.onBack}>
            <Back size={18} />
          </button>
          <BoardMark size={22} />
          {renaming ? (
            <input
              autoFocus
              defaultValue={manifest.title}
              className="h-8 min-w-[200px] rounded-[8px] border border-line bg-surface px-2 text-[14px] font-semibold outline-none focus:border-accent"
              onBlur={(e) => void rename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <button className="ml-1 min-w-0 truncate text-[14px] font-semibold hover:underline" title="Rename" onClick={() => setRenaming(true)}>
              {manifest.title}
            </button>
          )}
          <span className="tag hidden flex-none bg-soft text-muted xl:inline-flex">
            {PROJECT_KINDS[manifest.kind].label}
            {isSlides ? ` · ${SLIDES_ENGINES[anim === "video" ? "video" : "web"].label}` : ""}
            {isLab ? "" : ` · ${ASPECTS[manifest.aspect ?? "landscape"].label}`}
          </span>
        </div>

        <div style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          {!isLab && (
            <div className="seg" role="tablist" aria-label="Studio mode">
              {isSlides && (
                <button role="tab" aria-selected={mode === "deck"} data-on={mode === "deck"} onClick={() => setMode("deck")} disabled={Boolean(recording)}>
                  Slides
                </button>
              )}
              <button role="tab" aria-selected={mode === "edit"} data-on={mode === "edit"} onClick={() => setMode("edit")} disabled={Boolean(recording)}>
                {isSlides ? "Timeline" : "Animation"}
              </button>
              <button role="tab" aria-selected={mode === "voice"} data-on={mode === "voice"} onClick={() => setMode("voice")}>
                <i className="block h-[7px] w-[7px] rounded-full" style={{ background: mode === "voice" ? "var(--color-voice)" : "currentColor", opacity: mode === "voice" ? 1 : 0.5 }} />
                Voice-over
              </button>
            </div>
          )}
        </div>

        <div className="flex min-w-0 items-center justify-end gap-1.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <HistoryMenu projectId={manifest.id} disabled={p.busy || Boolean(recording)} onRestored={p.refresh} />
          <button className="icon-btn" title={props.dark ? "Light theme" : "Dark theme"} onClick={props.onToggleTheme}>
            {props.dark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button className="icon-btn relative" data-on={showChat} aria-pressed={showChat} title={showChat ? "Hide the assistant" : "Show the assistant"} onClick={toggleChat}>
            <ChatIcon size={17} />
            {p.busy && !showChat && <i className="absolute right-1.5 top-1.5 block h-2 w-2 animate-pulse rounded-full bg-assistant ring-2 ring-surface" />}
          </button>
          <button className="btn btn-accent ml-1" onClick={() => setShareOpen(true)} disabled={Boolean(recording)}>
            <Download size={15} /> Export
          </button>
        </div>
      </header>

      <div className="grid min-h-0" style={{ gridTemplateColumns: columns }}>
        <section className="relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
          {voicing && (
            <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-ink px-3.5 py-1.5 text-[12px] text-on-ink shadow-2 animate-in">
              <span className="spinner" /> {voicing}
            </div>
          )}
          <div className={`min-h-0 min-w-0 ${locked ? "pointer-events-none" : ""}`}>
            {deckMode ? (
              <SlidesStage
                projectId={manifest.id}
                revision={stageRevision}
                busy={stageBusy}
                aspect={manifest.aspect}
                slides={allScenes}
                activeSlide={activeScene}
                onActiveSlide={setSceneId}
                selection={selection}
                onSelect={(part, info) =>
                  setSelection(part ? { part, kind: info?.tag, sceneId: info?.slide ?? activeScene?.id, source: info?.slide ? { file: allScenes.find((x) => x.id === info.slide)?.file ?? "" } : undefined } : null)
                }
                onThumbnails={() => void p.reload()}
                leading={picker}
              />
            ) : isSlides && !animScenes.length ? (
              <div className="grid h-full place-items-center p-8 text-center text-muted">
                No animated slides yet. The timeline shows the Manim or manim-web slides once there are some.
              </div>
            ) : anim === "video" ? (
              <VideoStage
                projectId={manifest.id}
                scene={activeScene}
                scenes={scenes}
                revision={stageRevision}
                aspect={manifest.aspect}
                selection={selection}
                onSelect={setSelection}
                onActiveScene={setSceneId}
                bus={bus}
                infos={narration.infos}
                leading={picker}
                busy={stageBusy}
              />
            ) : anim === "web" ? (
              <WebStage
                projectId={manifest.id}
                revision={stageRevision}
                busy={stageBusy}
                scene={activeScene}
                scenes={scenes}
                aspect={manifest.aspect}
                selection={selection}
                onSelect={(part, info) => setSelection(part ? { part, kind: info?.tag, sceneId: activeScene?.id } : null)}
                onActiveScene={setSceneId}
                onThumbnails={() => void p.reload()}
                bus={bus}
                leading={picker}
              />
            ) : (
              <WebPreview projectId={manifest.id} revision={p.revision} busy={p.busy} onSelect={(part, info) => setSelection(part ? { part, kind: info?.tag } : null)} selection={selection} />
            )}
          </div>
          {!isLab &&
            !deckMode &&
            (editingTake && takeInfo?.source === "recording" ? (
              <TakeEditor
                key={editingTake}
                projectId={manifest.id}
                sceneId={editingTake}
                sceneTitle={scenes.find((s) => s.id === editingTake)?.title ?? ""}
                sceneNumber={sceneNumber(editingTake)}
                info={takeInfo}
                deviceId={mic.deviceId}
                onChanged={(info) => narration.patch(editingTake, { info })}
                onClose={() => setEditingTake(null)}
              />
            ) : (
              <div className={locked ? "pointer-events-none" : ""} aria-disabled={locked}>
              <Timeline
                bus={bus}
                thumbs={thumbs}
                infos={narration.infos}
                peaks={narration.peaks}
                activeSceneId={activeScene?.id}
                emptyHint={p.busy ? "The assistant is making the scenes…" : "The timeline fills in once there are scenes."}
                onAskStep={askStep}
              />
              </div>
            ))}
        </section>

        {mode === "voice" && <Splitter onDrag={(dx) => resize("voice", -dx)} onReset={() => resetSide("voice")} />}
        {mode === "voice" && (
          <aside className="min-h-0 overflow-hidden border-l border-line bg-surface" aria-label="Voice-over">
            <VoiceOver
              projectId={manifest.id}
              kind={anim === "web" ? "web" : "video"}
              scenes={scenes}
              activeSceneId={activeScene?.id}
              narration={narration}
              bus={bus}
              busy={p.busy}
              voiceSettings={manifest.voice}
              onAsk={ask}
              onSelectScene={setSceneId}
              mode={voiceMode}
              onMode={(m) => {
                setVoiceMode(m);
                store("board.voiceMode", m);
                if (m === "ai") setEditingTake(null);
              }}
              onEditTake={(id) => {
                setSceneId(id);
                setEditingTake(id);
              }}
              mic={mic}
              onMic={(s) => {
                setMic(s);
                saveMicSettings(s);
              }}
              recording={recording}
              onRecording={(id) => {
                setEditingTake(null);
                setRecording(id);
              }}
            />
          </aside>
        )}

        {showChat ? <Splitter onDrag={(dx) => resize("right", -dx)} onReset={() => resetSide("right")} /> : <div />}
        <div className={showChat ? "min-h-0 overflow-hidden" : "invisible min-h-0 overflow-hidden"} aria-hidden={!showChat}>
          <Chat
            projectId={manifest.id}
            agent={manifest.agent}
            providers={props.providers}
            turns={p.turns}
            busy={p.busy}
            error={p.error}
            selection={selection}
            sceneLabel={!isLab && activeScene ? `${isSlides ? "Slide" : "Scene"}: ${activeScene.title}` : undefined}
            onClearSelection={() => setSelection(null)}
            onSend={(text) => ask(text)}
            onClose={toggleChat}
            onAgentChange={async (agent) => {
              p.setProject((cur) => (cur ? { ...cur, manifest: { ...cur.manifest, agent } } : cur));
              await studio.agents.setSettings(manifest.id, agent);
            }}
          />
        </div>
      </div>

      {shareOpen && <ExportDialog manifest={manifest} onClose={() => setShareOpen(false)} onDeleted={props.onDeleted} />}
    </div>
  );
}

/** "Scene 2 · Title ▾": jump to a scene. Replaces the old scene list. */
function ScenePicker(props: { scenes: SceneMeta[]; active?: SceneMeta; onPick: (id: string) => void; vertical: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  const i = props.active ? props.scenes.indexOf(props.active) : -1;
  return (
    <div ref={ref} className="relative min-w-0 flex-none">
      <button className="btn btn-sm max-w-[260px] justify-start" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Go to a scene">
        <span className="grid h-5 min-w-5 flex-none place-items-center rounded-[5px] bg-stage px-1 font-mono text-[10.5px] text-white/85">{i + 1}</span>
        <span className="min-w-0 truncate">{props.active?.title ?? "Scenes"}</span>
        <span className="flex-none text-[10px] text-muted">▾</span>
      </button>
      {open && (
        <div role="listbox" className="absolute left-0 top-[calc(100%+6px)] z-30 max-h-[60vh] w-[300px] overflow-auto rounded-xl border border-line bg-surface p-1.5 shadow-2 animate-in">
          {props.scenes.map((s, j) => {
            const on = s.id === props.active?.id;
            return (
              <button
                key={s.id}
                role="option"
                aria-selected={on}
                className="flex w-full items-center gap-2.5 rounded-[8px] p-1.5 text-left hover:bg-surface-2"
                style={on ? { background: "var(--color-accent-soft)" } : undefined}
                onClick={() => {
                  props.onPick(s.id);
                  setOpen(false);
                }}
              >
                <span
                  className={`relative grid flex-none place-items-center overflow-hidden rounded-md bg-stage bg-cover bg-center font-mono text-[10.5px] text-white/75 ${props.vertical ? "aspect-[9/16] w-[26px]" : "aspect-video w-[56px]"}`}
                  style={s.thumbUrl ? { backgroundImage: `url("${s.thumbUrl}")` } : undefined}
                >
                  {s.thumbUrl ? <i className="absolute bottom-0.5 left-1 not-italic text-[10px] font-semibold text-white [text-shadow:0_1px_3px_#000]">{j + 1}</i> : j + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <b className={`block truncate text-[13px] font-medium leading-tight ${on ? "text-accent-ink" : ""}`}>{s.title}</b>
                  <small className="flex items-center gap-1.5 text-[11px] text-muted">
                    <i className="block h-[6px] w-[6px] rounded-full" style={{ background: s.status === "rendered" ? "var(--color-good)" : s.status === "error" ? "var(--color-bad)" : "var(--color-faint)" }} />
                    {s.status === "rendered" ? "Ready" : s.status === "error" ? "Needs a fix" : s.status === "rendering" ? "Rendering…" : "Sketch"}
                    {s.durationSec ? ` · ${Math.round(s.durationSec)} s` : ""}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
