import { useEffect, useRef, useState } from "react";
import { PROJECT_KINDS, SLIDES_ENGINES, type SlidesEngine, type AgentRequest, type AgentSettings, type Aspect, type CreateProjectInput, type ProjectKind, type ProjectLength, type ProjectSummary, type ProviderStatus } from "@studio/shared";
import { studio, timeAgo } from "../lib/api";
import { ArrowRight, Check, Flask, KindGlyph, SlidesIcon, VideoIcon, Wave } from "./Icons";
import { AgentControls } from "./ModelPicker";

const SUGGESTIONS: { text: string; kind: ProjectKind }[] = [
  { text: "Why does the unit circle give us sine and cosine?", kind: "video" },
  { text: "A projectile motion lab with sliders for angle and speed", kind: "lab" },
  { text: "Visualise compound interest growing over 30 years", kind: "web" },
  { text: "Let students explore how a and b change y = a·sin(bx)", kind: "lab" },
  { text: "A lesson on the derivative as the slope of a tangent, for Grade 11", kind: "slides" },
];

/** Each project type keeps one signal colour, like Apollo's destination tiles. */
export const KIND_TILE: Record<ProjectKind, { color: string; soft: string; icon: (p: { size?: number }) => React.ReactElement; hint: string }> = {
  video: { color: "var(--color-accent-ink)", soft: "var(--color-accent-soft)", icon: VideoIcon, hint: "Rendered with Manim on your computer. MP4 or GIF." },
  web: { color: "var(--color-context)", soft: "var(--color-context-soft)", icon: Wave, hint: "Plays in any browser. One HTML file or a GIF." },
  lab: { color: "var(--color-warn)", soft: "var(--color-warn-soft)", icon: Flask, hint: "An interactive page students explore. One HTML file." },
  slides: { color: "var(--color-voice)", soft: "var(--color-voice-soft)", icon: SlidesIcon, hint: "A deck you present step by step, with animated and interactive slides." },
};

const KIND_ORDER: ProjectKind[] = ["video", "web", "lab", "slides"];

const LENGTHS: Record<ProjectLength, { label: string; hint: (k: ProjectKind) => string }> = {
  short: { label: "Short", hint: (k) => (k === "lab" ? "One idea, one interaction" : k === "slides" ? "A handful of slides, five minutes" : "Under a minute, one idea") },
  explainer: { label: "Explainer", hint: (k) => (k === "lab" ? "A few sections to explore" : k === "slides" ? "10 to 15 slides, a short talk" : "Two to four minutes") },
  lesson: { label: "Full lesson", hint: (k) => (k === "lab" ? "A complete guided activity" : k === "slides" ? "A whole class period" : "A whole topic, step by step") },
};

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
  const [engine, setEngine] = useState<SlidesEngine>(() => (readText("board.slidesEngine") === "video" ? "video" : "web"));
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
      { kind, prompt: prompt.trim(), length, aspect: timed ? aspect : undefined, engine: kind === "slides" ? engine : undefined, agent: agent ?? { provider: ready!.id } },
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

        <div className="card">
          <div className="flex items-center gap-1 border-b border-line-2 px-2.5 pt-2" role="tablist" aria-label="What to make">
            {KIND_ORDER.map((k) => {
              const t = KIND_TILE[k];
              const Icon = t.icon;
              const on = kind === k;
              return (
                <button
                  key={k}
                  role="tab"
                  aria-selected={on}
                  onClick={() => setKind(k)}
                  className={`-mb-px flex items-center gap-2 border-b-2 px-2.5 pb-2 pt-1 text-[13.5px] font-medium transition-colors ${on ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}
                >
                  <span className="grid h-6 w-6 place-items-center rounded-[6px]" style={{ background: on ? t.soft : "transparent", color: on ? t.color : "currentColor" }}>
                    <Icon size={15} />
                  </span>
                  {PROJECT_KINDS[k].label}
                </button>
              );
            })}
            <span className="ml-auto hidden truncate pb-2 pl-3 text-[12px] text-faint md:block">{KIND_TILE[kind].hint}</span>
          </div>
          <div className="px-4 pt-3">
            <textarea
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
              }}
              placeholder={
                timed && fromScript
                  ? kind === "slides"
                    ? "Paste what you'll say. Board splits it into slides that follow your words and keeps it as speaker notes…"
                    : "Paste or write your narration. Board splits it into scenes, builds visuals that follow your words, then voices it…"
                  : kind === "slides"
                    ? "Describe the lesson, the class and what students should understand by the end…"
                  : kind === "lab"
                    ? "Describe what students should explore and the controls they get…"
                    : "Describe the idea, the class and what students should understand…"
              }
              className="min-h-[92px] w-full resize-none bg-transparent text-[15.5px] leading-[1.55] outline-none placeholder:text-faint"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3 pt-1">
            {kind === "slides" && (
              <MenuPill
                label={SLIDES_ENGINES[engine].label}
                value={engine}
                onChange={(v) => {
                  setEngine(v as SlidesEngine);
                  writeText("board.slidesEngine", v);
                }}
                options={(["web", "video"] as SlidesEngine[]).map((e) => ({ value: e, label: SLIDES_ENGINES[e].label, hint: SLIDES_ENGINES[e].hint }))}
              />
            )}
            {timed && (
              <>
                <MenuPill
                  label={fromScript ? "From my script" : "From an idea"}
                  value={fromScript ? "script" : "idea"}
                  onChange={(v) => setFromScript(v === "script")}
                  options={[
                    { value: "idea", label: "From an idea", hint: kind === "slides" ? "The assistant plans the slides and writes speaker notes" : "The assistant plans the scenes and writes the narration" },
                    { value: "script", label: "From my script", hint: kind === "slides" ? "Your words become the slides' speaker notes" : "Your words drive the scenes and are voiced as written" },
                  ]}
                />
                <MenuPill
                  label={
                    <>
                      <AspectIcon vertical={aspect === "vertical"} /> {aspect === "vertical" ? "9:16" : "16:9"}
                    </>
                  }
                  value={aspect}
                  onChange={(v) => setAspect(v as Aspect)}
                  options={[
                    { value: "landscape", label: "16:9 landscape", hint: "Slides, YouTube, the class screen" },
                    { value: "vertical", label: "9:16 vertical", hint: "Phones, Shorts, Reels, TikTok" },
                  ]}
                />
              </>
            )}
            <MenuPill
              label={LENGTHS[length].label}
              value={length}
              onChange={(v) => setLength(v as ProjectLength)}
              options={(Object.keys(LENGTHS) as ProjectLength[]).map((l) => ({ value: l, label: LENGTHS[l].label, hint: LENGTHS[l].hint(kind) }))}
            />
            <button
              className="pill"
              data-on={guided}
              aria-pressed={guided}
              title="The assistant asks two or three quick questions before it starts"
              onClick={() => {
                setGuided(!guided);
                writePref("board.guided", !guided);
              }}
            >
              <span className="grid h-3.5 w-3.5 place-items-center rounded-[4px] border border-current">{guided && <Check size={10} />}</span>
              Ask me first
            </button>
            <span className="flex-1" />
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
            <button className="btn btn-accent ml-1" disabled={!canStart} onClick={start} title="Start (Ctrl+Enter)">
              {props.creating ? "Creating…" : "Start"} <ArrowRight size={15} />
            </button>
          </div>
        </div>
        {props.error && <div className="mt-3 rounded-lg border border-bad-line bg-bad-soft px-3 py-2 text-bad">{props.error}</div>}

        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => {
            const Icon = KIND_TILE[s.kind].icon;
            return (
              <button
                key={s.text}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-2"
                onClick={() => {
                  setPrompt(s.text);
                  setKind(s.kind);
                }}
              >
                <span style={{ color: KIND_TILE[s.kind].color }}>
                  <Icon size={13} />
                </span>
                {s.text}
              </button>
            );
          })}
        </div>

        {recent.length > 0 && (
          <>
            <div className="mb-2.5 mt-9 flex items-baseline justify-between">
              <h2 className="m-0 text-[16px] font-semibold">Recent</h2>
              <button className="text-[13px] font-medium text-accent-ink hover:underline" onClick={props.onAllProjects}>
                All projects ({recent.length})
              </button>
            </div>
            <ProjectGrid projects={recent.slice(0, 6)} onOpen={props.onOpen} />
          </>
        )}
      </div>
    </div>
  );
}

/** Recent projects as picture cards. */
function ProjectGrid(props: { projects: ProjectSummary[]; onOpen: (id: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {props.projects.map((p) => (
        <button key={p.id} onClick={() => props.onOpen(p.id)} className="group card overflow-hidden text-left transition-shadow hover:shadow-2">
          <span className="relative grid aspect-video place-items-center overflow-hidden bg-stage">
            {p.thumbUrl ? (
              <img src={p.thumbUrl} alt="" className={`absolute inset-0 h-full w-full transition-transform duration-300 group-hover:scale-[1.03] ${p.aspect === "vertical" ? "object-contain" : "object-cover"}`} />
            ) : (
              <KindGlyph kind={p.kind} size={30} />
            )}
            <span className="absolute left-2 top-2 rounded-[5px] bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white/90">
              {PROJECT_KINDS[p.kind].label}
              {p.aspect === "vertical" ? " · 9:16" : ""}
            </span>
          </span>
          <span className="block px-3 pb-2.5 pt-2">
            <b className="block truncate text-[13.5px] font-semibold">{p.title}</b>
            <small className="text-[12px] text-muted">
              {p.sceneCount && p.kind !== "lab" ? `${p.sceneCount} ${p.kind === "slides" ? "slide" : "scene"}${p.sceneCount === 1 ? "" : "s"} · ` : ""}
              {timeAgo(p.updatedAt)}
            </small>
          </span>
        </button>
      ))}
    </div>
  );
}

/** A compact option menu: shows the current choice and opens a short list with hints. */
function MenuPill(props: { label: React.ReactNode; value: string; options: { value: string; label: string; hint?: string }[]; onChange: (v: string) => void }) {
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
  return (
    <div ref={ref} className="relative">
      <button className="pill" data-on={open} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {props.label}
        <span className="text-[9px] opacity-60">▾</span>
      </button>
      {open && (
        <div role="listbox" className="absolute left-0 top-[calc(100%+6px)] z-30 w-[270px] rounded-xl border border-line bg-surface p-1.5 shadow-2 animate-in">
          {props.options.map((o) => (
            <button
              key={o.value}
              role="option"
              aria-selected={o.value === props.value}
              className="flex w-full items-start gap-2 rounded-[8px] px-2.5 py-2 text-left hover:bg-surface-2"
              onClick={() => {
                props.onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="mt-[3px] w-3.5 flex-none text-accent-ink">{o.value === props.value && <Check size={13} />}</span>
              <span>
                <b className="block text-[13px] font-medium">{o.label}</b>
                {o.hint && <small className="block text-[12px] leading-snug text-muted">{o.hint}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
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
                {p.sceneCount && p.kind !== "lab" ? ` · ${p.sceneCount} ${p.kind === "slides" ? "slide" : "scene"}${p.sceneCount === 1 ? "" : "s"}` : ""}
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
          {(["all", "video", "web", "lab", "slides"] as const).map((k) => (
            <button key={k} data-on={filter === k} onClick={() => setFilter(k)}>
              {k === "all" ? "All" : k === "slides" ? "Slides" : PROJECT_KINDS[k].label + "s"}
              <span className="ml-1.5 text-[12px] text-faint">{(all ?? []).filter((p) => k === "all" || p.kind === k).length}</span>
            </button>
          ))}
        </div>
        {all === null ? (
          <div className="spinner" />
        ) : shown.length ? (
          <ProjectList projects={shown} onOpen={props.onOpen} />
        ) : (
          <div className="card p-8 text-center text-muted">{filter === "all" ? "No projects yet." : filter === "slides" ? "No slide decks yet." : `No ${PROJECT_KINDS[filter].label.toLowerCase()}s yet.`}</div>
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

function readText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeText(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}
