import { useEffect, useState } from "react";
import { ASPECTS, PROJECT_KINDS, type AgentRequest, type ProviderStatus, type Selection } from "@studio/shared";
import { errorMessage, studio } from "../lib/api";
import { useProject } from "../lib/useProject";
import { Chat } from "./Chat";
import { HistoryMenu } from "./HistoryMenu";
import { WebPreview } from "./WebPreview";
import { VideoStage } from "./VideoStage";
import { WebStage } from "./WebStage";
import { ExportDialog } from "./ExportDialog";
import { Narration } from "./Narration";
import { BoardMark } from "./Brand";
import { Back, ChatIcon, Download, Moon, Sun } from "./Icons";

const LAYOUT_KEY = "board.layout";
const DEFAULT_LAYOUT = { left: 196, right: 360 };
const LIMITS = { left: [150, 380], right: [300, 680] } as const;

function loadLayout(): { left: number; right: number } {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** A thin drag handle between panels, like an IDE. Double-click resets. */
function Splitter(props: { side: "left" | "right"; onDrag: (dx: number) => void; onReset: () => void }) {
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
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [layout, setLayout] = useState(loadLayout);
  const [chatOpen, setChatOpen] = useState(() => {
    try {
      return localStorage.getItem("board.assistant") !== "0";
    } catch {
      return true;
    }
  });
  const toggleChat = () =>
    setChatOpen((o) => {
      try {
        localStorage.setItem("board.assistant", o ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !o;
    });
  const resize = (side: "left" | "right", dx: number) =>
    setLayout((l) => {
      const next = { ...l, [side]: Math.min(LIMITS[side][1], Math.max(LIMITS[side][0], l[side] + dx)) };
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  const resetSide = (side: "left" | "right") => resize(side, DEFAULT_LAYOUT[side] - layout[side]);
  const manifest = p.project?.manifest;
  const scenes = manifest?.scenes ?? [];
  const activeScene = scenes.find((s) => s.id === sceneId) ?? scenes[scenes.length - 1];

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


  if (!p.project || !manifest) {
    return (
      <div className="grid h-full place-items-center text-muted">
        {p.error ? <div className="text-bad">{p.error}</div> : <div className="spinner" />}
      </div>
    );
  }

  const isLab = manifest.kind === "lab";
  const rename = async (value: string) => {
    setRenaming(false);
    if (value.trim() && value !== manifest.title) {
      await studio.projects.rename(manifest.id, value);
      await p.refresh();
    }
  };

  return (
    <div className="grid h-full grid-rows-[52px_minmax(0,1fr)]">
      <header className="flex min-w-0 items-center gap-2 border-b border-line bg-surface px-3.5" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
        <div className="flex min-w-0 flex-1 items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button className="icon-btn" title="Back to home" onClick={props.onBack}>
            <Back size={18} />
          </button>
          <BoardMark size={22} />
          {renaming ? (
            <input
              autoFocus
              defaultValue={manifest.title}
              className="h-8 min-w-[240px] rounded-[8px] border border-line bg-surface px-2 text-[14px] font-semibold outline-none focus:border-accent"
              onBlur={(e) => void rename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <button className="ml-1 truncate text-[14px] font-semibold hover:underline" title="Rename" onClick={() => setRenaming(true)}>
              {manifest.title}
            </button>
          )}
          <span className="tag flex-none bg-soft text-muted">
            {PROJECT_KINDS[manifest.kind].label}
            {isLab ? "" : ` · ${ASPECTS[manifest.aspect ?? "landscape"].label}`}
          </span>
        </div>
        <div className="flex flex-none items-center gap-1.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <HistoryMenu projectId={manifest.id} disabled={p.busy} onRestored={p.refresh} />
          <button className="icon-btn" title={props.dark ? "Light theme" : "Dark theme"} onClick={props.onToggleTheme}>
            {props.dark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button className="btn btn-accent" onClick={() => setShareOpen(true)}>
            <Download size={15} /> Export
          </button>
          <button
            className="btn"
            style={chatOpen ? { background: "var(--color-assistant)", borderColor: "transparent", color: "var(--color-on-assistant)" } : { background: "var(--color-accent-soft)", borderColor: "transparent", color: "var(--color-accent-ink)" }}
            aria-pressed={chatOpen}
            title={chatOpen ? "Hide the assistant" : "Show the assistant"}
            onClick={toggleChat}
          >
            <ChatIcon size={16} /> Assistant
          </button>
        </div>
      </header>

      <div className="grid min-h-0" style={{ gridTemplateColumns: `${isLab ? 0 : layout.left}px 0px minmax(0,1fr) 0px ${chatOpen ? layout.right : 0}px` }}>
      {/* Labs have no scenes. The cell stays in the grid (0 px wide) so the columns line up. */}
      <aside className={isLab ? "invisible overflow-hidden" : "overflow-auto border-r border-line bg-surface px-2.5 py-3.5"} aria-hidden={isLab}>
        <h3 className="mx-1.5 mb-2 mt-0 text-[12px] font-medium text-muted">Scenes</h3>
        {scenes.length === 0 && (
          <div className="mx-1 text-[12.5px] leading-snug text-muted">
            {p.busy ? "The assistant is sketching the first draft…" : "Nothing here yet. Describe what you want in the assistant panel."}
          </div>
        )}
        {scenes.map((s, i) => (
          <button
            key={s.id}
            onClick={() => setSceneId(s.id)}
            className="mb-1 flex w-full items-center gap-2.5 rounded-[10px] p-1.5 text-left hover:bg-surface-2"
            style={activeScene?.id === s.id ? { background: "var(--color-accent-soft)" } : undefined}
          >
            <span
              className={`relative grid flex-none place-items-center ${manifest.aspect === "vertical" ? "aspect-[9/16] w-[30px]" : "aspect-video w-[64px]"} overflow-hidden rounded-md bg-stage bg-cover bg-center font-mono text-[11px] text-white/70`}
              style={{
                ...(activeScene?.id === s.id ? { boxShadow: "0 0 0 2px var(--color-accent)" } : {}),
                ...(s.thumbUrl ? { backgroundImage: `url("${s.thumbUrl}")` } : {}),
              }}
            >
              {s.thumbUrl ? <i className="absolute bottom-0.5 left-1 not-italic text-[10px] font-semibold text-white [text-shadow:0_1px_3px_#000]">{i + 1}</i> : i + 1}
            </span>
            <span className="min-w-0">
              <b className="block truncate text-[12.5px] font-medium leading-tight">{s.title}</b>
              <small className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted">
                <i className="block h-[5px] w-[5px] rounded-full" style={{ background: s.status === "rendered" ? "var(--color-manim-green)" : s.status === "error" ? "var(--color-bad)" : "var(--color-faint)" }} />
                {manifest.kind === "lab" ? s.id : s.status}
              </small>
            </span>
          </button>
        ))}
      </aside>
      {isLab ? <div /> : <Splitter side="left" onDrag={(dx) => resize("left", dx)} onReset={() => resetSide("left")} />}

      <section className="relative min-h-0 min-w-0 overflow-hidden">
        {voicing && (
          <div className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-ink px-3.5 py-1.5 text-[12px] text-on-ink shadow-2 animate-in">
            <span className="spinner" /> {voicing}
          </div>
        )}
        {manifest.kind === "video" ? (
          <VideoStage
            projectId={manifest.id}
            scene={activeScene}
            scenes={scenes}
            revision={p.revision}
            aspect={manifest.aspect}
            selection={selection}
            onSelect={setSelection}
            onActiveScene={setSceneId}
          />
        ) : manifest.kind === "web" ? (
          <WebStage
            projectId={manifest.id}
            revision={p.revision}
            busy={p.busy}
            scene={activeScene}
            scenes={scenes}
            aspect={manifest.aspect}
            selection={selection}
            onSelect={(part, info) => setSelection(part ? { part, kind: info?.tag, sceneId: activeScene?.id } : null)}
            onActiveScene={setSceneId}
            onThumbnails={() => void p.reload()}
          />
        ) : (
          <WebPreview
            projectId={manifest.id}
            revision={p.revision}
            busy={p.busy}
            onSelect={(part, info) =>
              setSelection(part ? { part, kind: info?.tag, sceneId: activeScene?.id } : null)
            }
            selection={selection}
          />
        )}
      </section>
      {chatOpen ? <Splitter side="right" onDrag={(dx) => resize("right", -dx)} onReset={() => resetSide("right")} /> : <div />}

      <div className={chatOpen ? "min-h-0 overflow-hidden" : "invisible min-h-0 overflow-hidden"}>
      <Chat
        projectId={manifest.id}
        agent={manifest.agent}
        providers={props.providers}
        turns={p.turns}
        busy={p.busy}
        error={p.error}
        selection={selection}
        sceneLabel={!isLab && activeScene ? `Scene: ${activeScene.title}` : undefined}
        onClearSelection={() => setSelection(null)}
        onSend={(text) => {
          void p.send(text, { selection: selection ?? undefined, sceneId: activeScene?.id });
          setSelection(null);
        }}
        narration={
          manifest.kind === "lab" ? undefined : (
            <Narration
              projectId={manifest.id}
              kind={manifest.kind === "web" ? "web" : "video"}
              scenes={scenes}
              activeSceneId={activeScene?.id}
              revision={p.revision}
              voiceSettings={manifest.voice}
              busy={p.busy}
              onAsk={(text, sceneId) => void p.send(text, { sceneId: sceneId ?? activeScene?.id })}
              onSelectScene={setSceneId}
            />
          )
        }
        onAgentChange={async (agent) => {
          p.setProject((cur) => (cur ? { ...cur, manifest: { ...cur.manifest, agent } } : cur));
          await studio.agents.setSettings(manifest.id, agent);
        }}
      />
      </div>
      </div>

      {shareOpen && (
        <ExportDialog manifest={manifest} onClose={() => setShareOpen(false)} onDeleted={props.onDeleted} />
      )}
    </div>
  );
}
