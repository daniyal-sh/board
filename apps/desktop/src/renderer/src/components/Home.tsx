import { useEffect, useState } from "react";
import { PROJECT_KINDS, type CreateProjectInput, type ProjectKind, type ProjectLength, type ProjectSummary, type ProviderStatus } from "@studio/shared";
import { studio, timeAgo } from "../lib/api";
import { ArrowRight, KindGlyph } from "./Icons";

const SUGGESTIONS: { text: string; kind: ProjectKind }[] = [
  { text: "Why does the unit circle give us sine and cosine?", kind: "video" },
  { text: "A projectile motion lab with sliders for angle and speed", kind: "lab" },
  { text: "Visualise compound interest growing over 30 years", kind: "web" },
  { text: "Let students explore how a and b change y = a·sin(bx)", kind: "lab" },
];

const KIND_ORDER: ProjectKind[] = ["video", "web", "lab"];

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Home(props: {
  providers: ProviderStatus[] | null;
  creating: boolean;
  error: string | null;
  onCreate: (input: CreateProjectInput) => void;
  onOpen: (id: string) => void;
  onOpenSettings: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<ProjectKind>("lab");
  const [length, setLength] = useState<ProjectLength>("explainer");
  const [recent, setRecent] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    void studio.projects.list().then(setRecent);
  }, []);

  const ready = props.providers?.find((p) => p.installed && p.authenticated !== false);
  const noAgent = props.providers !== null && !ready;
  const canStart = prompt.trim().length > 3 && !props.creating && !noAgent;

  function start() {
    if (!canStart) return;
    props.onCreate({ kind, prompt: prompt.trim(), length, provider: ready?.id });
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[800px] px-6 pb-14 pt-16">
        <div className="eyebrow">{greeting()}</div>
        <h1 className="serif mb-7 mt-1.5 text-[52px] leading-[1.02] tracking-[-0.02em]">
          What would you like to <em className="text-accent">explain</em> today?
        </h1>

        {noAgent && (
          <div className="card mb-4 flex items-center gap-3 border-l-4 border-warn p-4 animate-in">
            <div className="flex-1">
              <b className="font-semibold">Connect an assistant to get started</b>
              <div className="text-muted">Install Claude Code or Codex and sign in with your existing subscription.</div>
            </div>
            <button className="btn btn-sm" onClick={props.onOpenSettings}>
              Set up
            </button>
          </div>
        )}

        <div className="rounded-[18px] bg-surface p-4 pb-3 shadow-2">
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
            }}
            placeholder="Describe the idea, the class and what students should understand…"
            className="min-h-[76px] w-full resize-none bg-transparent text-[16px] leading-[1.55] outline-none placeholder:text-faint"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-[12px] text-muted">Ctrl+Enter to start</span>
            <span className="flex-1" />
            <div className="seg">
              {(["short", "explainer", "lesson"] as ProjectLength[]).map((l) => (
                <button key={l} data-on={length === l} onClick={() => setLength(l)}>
                  {l === "short" ? "Short" : l === "explainer" ? "Explainer" : "Full lesson"}
                </button>
              ))}
            </div>
            <button className="btn btn-accent" disabled={!canStart} onClick={start}>
              {props.creating ? "Creating…" : "Start"} <ArrowRight size={14} />
            </button>
          </div>
        </div>
        {props.error && <div className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-bad">{props.error}</div>}

        <div className="mt-[18px] flex gap-2">
          {KIND_ORDER.map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className="flex flex-1 items-center gap-3 rounded-[14px] p-3 text-left transition"
              style={{
                background: kind === k ? "#fff" : "rgba(255,255,255,.55)",
                boxShadow: kind === k ? "inset 0 0 0 2px var(--color-ink)" : "inset 0 0 0 1px var(--color-line)",
              }}
            >
              <span className="grid h-[42px] w-[42px] flex-none place-items-center rounded-[10px] bg-stage">
                <KindGlyph kind={k} />
              </span>
              <span>
                <b className="block font-semibold">{PROJECT_KINDS[k].label}</b>
                <small className="block text-[12px] leading-snug text-muted">{PROJECT_KINDS[k].blurb}</small>
              </span>
            </button>
          ))}
        </div>

        <div className="mt-3.5 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.text}
              className="rounded-full border border-line bg-white/60 px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-white"
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
            <div className="mb-3 mt-11 flex items-baseline justify-between">
              <h2 className="serif m-0 text-[22px]">Recent</h2>
              <span className="text-[12px] text-muted">{recent.length} projects</span>
            </div>
            <div className="grid grid-cols-3 gap-4">
              {recent.slice(0, 9).map((p) => (
                <button key={p.id} className="group text-left" onClick={() => props.onOpen(p.id)}>
                  <div className="relative mb-2 grid aspect-video place-items-center overflow-hidden rounded-xl bg-stage shadow-1 transition group-hover:-translate-y-0.5 group-hover:shadow-2">
                    {p.thumbUrl ? <img src={p.thumbUrl} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <KindGlyph kind={p.kind} size={44} />}
                    <span className="absolute left-2 top-2 rounded-md bg-white/90 px-1.5 py-0.5 text-[10.5px] font-medium">{PROJECT_KINDS[p.kind].label}</span>
                    {p.publish && <span className="absolute right-2 top-2 rounded-md bg-accent px-1.5 py-0.5 text-[10.5px] font-medium text-white">Published</span>}
                  </div>
                  <b className="block font-medium">{p.title}</b>
                  <span className="text-[12px] text-muted">{timeAgo(p.updatedAt)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
