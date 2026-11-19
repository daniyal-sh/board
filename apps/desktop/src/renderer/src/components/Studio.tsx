import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { PROJECT_KINDS, type ProviderStatus, type Selection } from "@studio/shared";
import { studio } from "../lib/api";
import { useProject } from "../lib/useProject";
import { Chat } from "./Chat";
import { HistoryMenu } from "./HistoryMenu";
import { WebPreview } from "./WebPreview";
import { VideoStage } from "./VideoStage";
import { ShareDialog } from "./ShareDialog";
import { Narration } from "./Narration";

const LAYOUT_KEY = "studio.layout";
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

export function Studio(props: {
  projectId: string;
  firstPrompt?: string;
  providers: ProviderStatus[] | null;
  onTitle: (node: React.ReactNode) => void;
  onDeleted: () => void;
}) {
  const p = useProject(props.projectId);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [layout, setLayout] = useState(loadLayout);
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
    if (p.project.chat.length === 0) void p.send(props.firstPrompt);
  }, [props.firstPrompt, props.projectId, p.project, p.send]);

  // Keep the agent tools informed about the selection.
  useEffect(() => {
    void studio.agents.setSelection(props.projectId, selection);
  }, [props.projectId, selection]);

  useEffect(() => {
    if (!manifest) return;
    props.onTitle(
      renaming ? (
        <input
          autoFocus
          defaultValue={manifest.title}
          className="rounded-md border border-line bg-white px-2 py-0.5 font-medium outline-none"
          onBlur={async (e) => {
            setRenaming(false);
            if (e.target.value.trim() && e.target.value !== manifest.title) {
              await studio.projects.rename(manifest.id, e.target.value);
              await p.refresh();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setRenaming(false);
          }}
        />
      ) : (
        <>
          <button className="truncate font-medium hover:underline" title="Rename" onClick={() => setRenaming(true)}>
            {manifest.title}
          </button>
          <span className="rounded-full bg-black/5 px-2 py-0.5 text-[11px] font-medium text-ink-2">
            {PROJECT_KINDS[manifest.kind].label} · {PROJECT_KINDS[manifest.kind].engine}
          </span>
        </>
      ),
    );
  }, [manifest, renaming]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => props.onTitle(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const actionsHost = useMemo(() => document.getElementById("titlebar-actions"), []);

  if (!p.project || !manifest) {
    return (
      <div className="grid h-full place-items-center text-muted">
        {p.error ? <div className="text-bad">{p.error}</div> : <div className="spinner" />}
      </div>
    );
  }

  const listLabel = manifest.kind === "lab" ? "Sections" : "Scenes";

  return (
    <div className="grid h-full" style={{ gridTemplateColumns: `${layout.left}px 0px minmax(0,1fr) 0px ${layout.right}px` }}>
      {actionsHost &&
        createPortal(
          <>
            <HistoryMenu projectId={manifest.id} disabled={p.busy} onRestored={p.refresh} />
            <button className="btn btn-dark btn-sm" onClick={() => setShareOpen(true)}>
              Share
            </button>
          </>,
          actionsHost,
        )}

      <aside className="overflow-auto py-3.5 pl-3.5 pr-2.5">
        <h3 className="serif mx-1 mb-2.5 mt-0 text-[19px]">{listLabel}</h3>
        {scenes.length === 0 && (
          <div className="mx-1 text-[12.5px] leading-snug text-muted">
            {p.busy ? "The assistant is sketching the first draft…" : "Nothing here yet. Describe what you want in the assistant panel."}
          </div>
        )}
        {scenes.map((s, i) => (
          <button
            key={s.id}
            onClick={() => setSceneId(s.id)}
            className="mb-1 flex w-full items-center gap-2.5 rounded-[10px] p-1.5 text-left hover:bg-black/[.04]"
            style={activeScene?.id === s.id ? { background: "#fff", boxShadow: "var(--shadow-1)" } : undefined}
          >
            <span
              className="grid aspect-video w-[54px] flex-none place-items-center rounded-md bg-stage font-mono text-[11px] text-white/70"
              style={activeScene?.id === s.id ? { boxShadow: "0 0 0 2px var(--color-accent)" } : undefined}
            >
              {i + 1}
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
      <Splitter side="left" onDrag={(dx) => resize("left", dx)} onReset={() => resetSide("left")} />

      <section className="min-h-0 min-w-0">
        {manifest.kind === "video" ? (
          <VideoStage
            projectId={manifest.id}
            scene={activeScene}
            scenes={scenes}
            revision={p.revision}
            selection={selection}
            onSelect={setSelection}
            onActiveScene={setSceneId}
          />
        ) : (
          <WebPreview
            projectId={manifest.id}
            kind={manifest.kind}
            revision={p.revision}
            busy={p.busy}
            sceneId={manifest.kind === "web" ? activeScene?.id : undefined}
            onSelect={(part, info) =>
              setSelection(part ? { part, kind: info?.tag, sceneId: activeScene?.id } : null)
            }
            selection={selection}
          />
        )}
      </section>
      <Splitter side="right" onDrag={(dx) => resize("right", -dx)} onReset={() => resetSide("right")} />

      <Chat
        projectId={manifest.id}
        agent={manifest.agent}
        providers={props.providers}
        turns={p.turns}
        busy={p.busy}
        error={p.error}
        selection={selection}
        sceneLabel={activeScene ? `${manifest.kind === "lab" ? "Section" : "Scene"}: ${activeScene.title}` : undefined}
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

      {shareOpen && (
        <ShareDialog
          manifest={manifest}
          onClose={() => setShareOpen(false)}
          onChanged={p.refresh}
          onDeleted={props.onDeleted}
        />
      )}
    </div>
  );
}
