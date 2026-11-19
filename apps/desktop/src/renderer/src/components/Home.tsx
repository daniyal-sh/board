import { useEffect, useState } from "react";
import { PROJECT_KINDS, type AgentRequest, type AgentSettings, type Aspect, type CreateProjectInput, type ProjectKind, type ProjectLength, type ProjectSummary, type ProviderStatus } from "@studio/shared";
import { studio, timeAgo } from "../lib/api";
import { ArrowRight, Flask, KindGlyph, VideoIcon, Wave } from "./Icons";
import { AgentControls } from "./ModelPicker";

const SUGGESTIONS: { text: string; kind: ProjectKind }[] = [
  { text: "Why does the unit circle give us sine and cosine?", kind: "video" },
  { text: "A projectile motion lab with sliders for angle and speed", kind: "lab" },
  { text: "Visualise compound interest growing over 30 years", kind: "web" },
  { text: "Let students explore how a and b change y = a·sin(bx)", kind: "lab" },
];

/** Each project type keeps one signal colour, like Apollo's destination tiles. */
export const KIND_TILE: Record<ProjectKind, { color: string; soft: string; icon: (p: { size?: number }) => React.ReactElement; hint: string }> = {
  video: { color: "var(--color-accent-ink)", soft: "var(--color-accent-soft)", icon: VideoIcon, hint: "Rendered with Manim on your computer. MP4 or GIF." },
  web: { color: "var(--color-context)", soft: "var(--color-context-soft)", icon: Wave, hint: "Plays in any browser. One HTML file or a GIF." },
  lab: { color: "var(--color-warn)", soft: "var(--color-warn-soft)", icon: Flask, hint: "An interactive page students explore. One HTML file." },
};

const KIND_ORDER: ProjectKind[] = ["video", "web", "lab"];

export function Home(props: {
  providers: ProviderStatus[] | null;
  creating: boolean;
  error: string | null;
  onCreate: (input: CreateProjectInput, intro: AgentRequest["intro"]) => void;
  onOpen: (id: string) => void;
  onOpenSettings: () => void;
  onAllProjects: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<ProjectKind>("video");
  const [length, setLength] = useState<ProjectLength>("explainer");
  const [recent, setRecent] = useState<ProjectSummary[]>([]);
  const [agent, setAgent] = useState<AgentSettings | null>(null);
  const [aspect, setAspect] = useState<Aspect>("landscape");
  const [fromScript, setFromScript] = useState(false);
  const [guided, setGuided] = useState(() => readPref("board.guided", true));
  const timed = kind !== "lab";

  useEffect(() => {
    void studio.projects.list().then(setRecent);
    void studio.agents.defaults().then(setAgent);
  }, []);

  // If the remembered assistant isn't usable on this computer, fall back to one that is.
  useEffect(() => {
    if (!agent || !props.providers) return;
    const ok = (id: string) => props.providers!.some((p) => p.id === id && p.installed && p.authenticated !== false);
    if (!ok(agent.provider)) {
      const other = props.providers.find((p) => p.installed && p.authenticated !== false);
      if (other) setAgent({ provider: other.id });
    }
  }, [agent, props.providers]);

  const ready = props.providers?.find((p) => p.installed && p.authenticated !== false);
  const noAgent = props.providers !== null && !ready;
  const canStart = prompt.trim().length > 3 && !props.creating && !noAgent;

  function start() {
    if (!canStart) return;
    props.onCreate(
      { kind, prompt: prompt.trim(), length, aspect: timed ? aspect : undefined, agent: agent ?? { provider: ready!.id } },
      { guided, script: timed && fromScript },
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[880px] px-8 pb-14 pt-10">
        <h1 className="m-0 text-[32px] font-semibold leading-[1.15] tracking-[-0.02em]">What would you like to explain?</h1>
        <p className="mb-6 mt-2 text-[15px] text-muted">
          Describe an idea or paste your script. Your assistant builds it on this computer, and you can change anything by clicking it.
        </p>

        {noAgent && (
          <div className="mb-4 flex items-center gap-3 rounded-[12px] border border-warn-line bg-warn-soft p-4 animate-in">
            <div className="flex-1">
              <b className="font-semibold">Connect an assistant to get started</b>
              <div className="text-ink-2">Install Claude Code or Codex and sign in with your existing subscription.</div>
            </div>
            <button className="btn btn-sm" onClick={props.onOpenSettings}>
              Set up
            </button>
          </div>
        )}

        <div className="card p-4 pb-3">
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
            }}
            placeholder={
              timed && fromScript
                ? "Paste or write your narration. Board splits it into scenes, builds visuals that follow your words, then voices it…"
                : "Describe the idea, the class and what students should understand…"
            }
            className="min-h-[76px] w-full resize-none bg-transparent text-[15.5px] leading-[1.55] outline-none placeholder:text-faint"
          />
          <div className="mt-1.5 flex items-center gap-2">
            {agent && (
              <AgentControls
                value={agent}
                providers={props.providers}
                placement="down"
                onChange={(a) => {
                  setAgent(a);
                  void studio.agents.setDefaults(a);
                }}
              />
            )}
            <span className="flex-1" />
            <button className="btn btn-accent btn-lg" disabled={!canStart} onClick={start} title="Start (Ctrl+Enter)">
              {props.creating ? "Creating…" : "Start"} <ArrowRight size={15} />
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2.5 text-[13px] text-muted">
          {timed && (
            <>
              <div className="seg" title="What you're starting from">
                <button data-on={!fromScript} onClick={() => setFromScript(false)}>
                  An idea
                </button>
                <button data-on={fromScript} onClick={() => setFromScript(true)}>
                  My script
                </button>
              </div>
              <div className="seg" title="Shape of the video">
                <button data-on={aspect === "landscape"} onClick={() => setAspect("landscape")}>
                  <AspectIcon vertical={false} /> 16:9
                </button>
                <button data-on={aspect === "vertical"} onClick={() => setAspect("vertical")}>
                  <AspectIcon vertical /> 9:16
                </button>
              </div>
            </>
          )}
          <div className="seg" title="How long">
            {(["short", "explainer", "lesson"] as ProjectLength[]).map((l) => (
              <button key={l} data-on={length === l} onClick={() => setLength(l)}>
                {l === "short" ? "Short" : l === "explainer" ? "Explainer" : "Full lesson"}
              </button>
            ))}
          </div>
          <label className="ml-auto flex cursor-pointer select-none items-center gap-2 text-ink">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--color-accent)]"
              checked={guided}
              onChange={(e) => {
                setGuided(e.target.checked);
                writePref("board.guided", e.target.checked);
              }}
            />
            Ask me a few questions first
          </label>
        </div>
        {props.error && <div className="mt-3 rounded-lg border border-bad-line bg-bad-soft px-3 py-2 text-bad">{props.error}</div>}

        <div className="mt-5 grid grid-cols-3 gap-2.5">
          {KIND_ORDER.map((k) => {
            const t = KIND_TILE[k];
            const Icon = t.icon;
            return (
              <button
                key={k}
                onClick={() => setKind(k)}
                className="flex items-start gap-3 rounded-[12px] border bg-surface p-3.5 text-left transition-shadow"
                style={kind === k ? { borderColor: "transparent", boxShadow: "0 0 0 2px var(--color-accent)" } : { borderColor: "var(--color-line)" }}
                aria-pressed={kind === k}
              >
                <span className="grid h-9 w-9 flex-none place-items-center rounded-[9px]" style={{ background: t.soft, color: t.color }}>
                  <Icon size={18} />
                </span>
                <span>
                  <b className="block text-[14.5px] font-semibold">{PROJECT_KINDS[k].label}</b>
                  <small className="mt-0.5 block text-[12.5px] leading-snug text-muted">{t.hint}</small>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.text}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-2"
              onClick={() => {
                setPrompt(s.text);
                setKind(s.kind);
              }}
            >
              {s.text}
            </button>
          ))}
        </div>

        {recent.length > 0 && (
          <>
            <div className="mb-2.5 mt-9 flex items-baseline justify-between">
              <h2 className="m-0 text-[16px] font-semibold">Recent</h2>
              <button className="text-[13px] font-medium text-accent-ink hover:underline" onClick={props.onAllProjects}>
                All projects ({recent.length})
              </button>
            </div>
            <ProjectList projects={recent.slice(0, 6)} onOpen={props.onOpen} />
          </>
        )}
      </div>
    </div>
  );
}

/** Apollo-style list: one bordered surface, a row per project. */
export function ProjectList(props: { projects: ProjectSummary[]; onOpen: (id: string) => void }) {
  return (
    <div className="card overflow-hidden">
      {props.projects.map((p, i) => {
        const vertical = p.aspect === "vertical";
        return (
          <button
            key={p.id}
            onClick={() => props.onOpen(p.id)}
            className={`grid w-full grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-3.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2 ${i ? "border-t border-line" : ""}`}
          >
            <span className={`relative grid place-items-center overflow-hidden rounded-md bg-stage ${vertical ? "aspect-[9/16] w-[30px] justify-self-center" : "aspect-video w-[72px]"}`}>
              {p.thumbUrl ? <img src={p.thumbUrl} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <KindGlyph kind={p.kind} size={22} />}
            </span>
            <span className="min-w-0">
              <b className="block truncate text-[14px] font-semibold">{p.title}</b>
              <small className="text-[12.5px] text-muted">
                {PROJECT_KINDS[p.kind].label}
                {vertical ? " · 9:16" : ""}
                {p.sceneCount && p.kind !== "lab" ? ` · ${p.sceneCount} scene${p.sceneCount === 1 ? "" : "s"}` : ""}
              </small>
            </span>
            <span className="w-[84px] text-right text-[12.5px] text-muted">{timeAgo(p.updatedAt)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** All projects, filtered by type. */
export function ProjectsPage(props: { onOpen: (id: string) => void; onNew: () => void }) {
  const [all, setAll] = useState<ProjectSummary[] | null>(null);
  const [filter, setFilter] = useState<ProjectKind | "all">("all");
  useEffect(() => {
    void studio.projects.list().then(setAll);
  }, []);
  const shown = (all ?? []).filter((p) => filter === "all" || p.kind === filter);
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[880px] px-8 pb-14 pt-10">
        <div className="mb-5 flex items-end gap-3">
          <div className="flex-1">
            <h1 className="m-0 text-[28px] font-semibold tracking-[-0.02em]">Projects</h1>
            <p className="mb-0 mt-1 text-muted">Everything is saved in your Documents folder, with every change kept as a version.</p>
          </div>
          <button className="btn btn-accent" onClick={props.onNew}>
            New project
          </button>
        </div>
        <div className="tabs mb-4">
          {(["all", "video", "web", "lab"] as const).map((k) => (
            <button key={k} data-on={filter === k} onClick={() => setFilter(k)}>
              {k === "all" ? "All" : PROJECT_KINDS[k].label + "s"}
              <span className="ml-1.5 text-[12px] text-faint">{(all ?? []).filter((p) => k === "all" || p.kind === k).length}</span>
            </button>
          ))}
        </div>
        {all === null ? (
          <div className="spinner" />
        ) : shown.length ? (
          <ProjectList projects={shown} onOpen={props.onOpen} />
        ) : (
          <div className="card p-8 text-center text-muted">{filter === "all" ? "No projects yet." : `No ${PROJECT_KINDS[filter].label.toLowerCase()}s yet.`}</div>
        )}
      </div>
    </div>
  );
}

function AspectIcon(props: { vertical: boolean }) {
  return <i className="inline-block rounded-[2px] border-[1.5px] border-current align-[-1px]" style={props.vertical ? { width: 7, height: 11 } : { width: 13, height: 8 }} />;
}

function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key) ?? localStorage.getItem(key.replace("board.", "studio."));
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* private mode */
  }
}
