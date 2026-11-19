import { useEffect, useRef, useState } from "react";
import type { AgentSettings, ApprovalDecision, ApprovalRequest, ChatTurn, ProviderStatus, Selection } from "@studio/shared";
import { studio } from "../lib/api";
import { ArrowUp, Check, Stop, Undo } from "./Icons";
import { Markdown } from "./Markdown";
import { AgentControls } from "./ModelPicker";

type Step = ChatTurn["steps"][number];

function elapsed(from: string, to = Date.now()): string {
  const s = Math.max(0, Math.round((to - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** "edited 3 files · checked the preview" from a turn's steps. */
function summarize(steps: Step[]): string {
  const edited = new Set(steps.filter((s) => s.label === "Editing").map((s) => s.detail)).size;
  const parts: string[] = [];
  if (edited) parts.push(`edited ${edited} file${edited > 1 ? "s" : ""}`);
  if (steps.some((s) => s.label === "Rendering the preview")) parts.push("rendered");
  if (steps.some((s) => s.label === "Checking how it looks")) parts.push("checked the result");
  return parts.join(" · ") || `${steps.length} step${steps.length === 1 ? "" : "s"}`;
}

/** Steps fold into one line; the running step shows live. Click to see them all. */
function Activity({ turn }: { turn: ChatTurn }) {
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const running = turn.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  const steps = turn.steps;
  const live = [...steps].reverse().find((s) => s.status === "running") ?? steps[steps.length - 1];
  const errors = steps.filter((s) => s.status === "error").length;
  if (!steps.length && !running) return null;

  return (
    <div className="my-1">
      <button onClick={() => setOpen((o) => !o)} className="group flex w-full items-center gap-2 rounded-lg py-1 text-left text-[12px] text-muted hover:text-ink-2">
        {running ? <span className="spinner h-3.5 w-3.5 flex-none" /> : <Check size={12} className="flex-none text-good" />}
        <span className="min-w-0 flex-1 truncate">
          {running ? (
            <>
              <span className="text-ink-2">{live ? live.label : "Thinking"}</span>
              {live?.detail && <span> {live.detail}</span>}
              <span> · {elapsed(turn.startedAt)}</span>
            </>
          ) : (
            <>
              {turn.finishedAt ? `Worked ${elapsed(turn.startedAt, new Date(turn.finishedAt).getTime())}` : "Done"}
              {" · "}
              {summarize(steps)}
              {errors ? ` · ${errors} retried` : ""}
            </>
          )}
        </span>
        {steps.length > 0 && <span className="flex-none text-[10px] opacity-0 transition group-hover:opacity-100">{open ? "Hide" : "Details"}</span>}
      </button>
      {open && (
        <div className="mb-1 ml-[5px] border-l border-line pl-3 animate-in">
          {steps.map((s) => (
            <div key={s.stepId} className="flex items-baseline gap-2 py-[3px] text-[12px]">
              <span className={s.status === "error" ? "text-bad" : s.status === "running" ? "text-accent" : "text-faint"}>{s.status === "error" ? "!" : "•"}</span>
              <span className="text-ink-2">{s.label}</span>
              {s.detail && <span className="truncate text-muted">{s.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const ALWAYS_LABEL: Record<ApprovalRequest["kind"], string> = {
  command: "Always allow commands",
  web: "Always allow web access",
  file: "Always allow outside files",
  other: "Always allow this",
};

/** The assistant asks before doing something outside its access level. */
function ApprovalCard(props: { projectId: string; approval: ApprovalRequest & { decision?: ApprovalDecision } }) {
  const a = props.approval;
  const answer = (d: ApprovalDecision) => void studio.agents.respondApproval(props.projectId, a.requestId, d);
  if (a.decision) {
    return (
      <div className="my-1 flex items-center gap-1.5 text-[12px] text-muted">
        <span className={a.decision === "deny" ? "text-bad" : "text-good"}>{a.decision === "deny" ? "✕" : "✓"}</span>
        <span className="truncate">
          {a.decision === "deny" ? "Declined" : a.decision === "always" ? "Allowed (and from now on)" : "Allowed"}: {a.title}
          {a.detail ? ` · ${a.detail}` : ""}
        </span>
      </div>
    );
  }
  return (
    <div className="my-2 rounded-xl bg-surface p-3 shadow-[0_0_0_1.5px_var(--color-accent),var(--shadow-1)] animate-in">
      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
        <span className="grid h-5 w-5 place-items-center rounded-md bg-accent-soft text-[11px] text-accent">?</span>
        {a.title}?
      </div>
      {a.reason && <p className="mb-0 mt-1.5 text-[12px] text-ink-2">{a.reason}</p>}
      {a.detail && <pre className="mb-0 mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 px-2.5 py-1.5 font-mono text-[11px] text-ink-2">{a.detail}</pre>}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <button className="btn btn-dark btn-sm" onClick={() => answer("allow")}>
          Allow
        </button>
        <button className="btn btn-sm" onClick={() => answer("always")}>
          {ALWAYS_LABEL[a.kind]}
        </button>
        <span className="flex-1" />
        <button className="btn btn-ghost btn-sm" onClick={() => answer("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}

export function Chat(props: {
  projectId: string;
  agent: AgentSettings;
  providers: ProviderStatus[] | null;
  turns: ChatTurn[];
  busy: boolean;
  error: string | null;
  selection: Selection | null;
  sceneLabel?: string;
  onClearSelection: () => void;
  onSend: (text: string) => void;
  onAgentChange: (a: AgentSettings) => void;
  /** Narration panel for videos and web animations. */
  narration?: React.ReactNode;
}) {
  const [text, setText] = useState("");
  const [tab, setTab] = useState<"chat" | "narration">("chat");
  /** Last undo, so it can be redone. Cleared when a new turn starts. */
  const [undone, setUndone] = useState<{ undone: string; message: string } | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: "smooth" });
  }, [props.turns]);

  useEffect(() => {
    if (props.selection) {
      setTab("chat");
      input.current?.focus();
    }
  }, [props.selection]);

  useEffect(() => {
    if (props.busy) setUndone(null);
  }, [props.busy]);

  function submit() {
    const t = text.trim();
    if (!t || props.busy) return;
    props.onSend(t);
    setText("");
  }

  const last = props.turns[props.turns.length - 1];
  const canUndo = !props.busy && !undone && last && last.status !== "running" && (last.commit || last.status === "error");

  async function undo() {
    setUndoBusy(true);
    try {
      setUndone(await studio.projects.undo(props.projectId));
    } finally {
      setUndoBusy(false);
    }
  }
  async function redo() {
    if (!undone) return;
    setUndoBusy(true);
    try {
      await studio.projects.restore(props.projectId, undone.undone);
      setUndone(null);
    } finally {
      setUndoBusy(false);
    }
  }

  return (
    <aside className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-white/40">
      <div className="flex items-center gap-2 px-4 pb-2 pt-3">
        {props.narration ? (
          <div className="seg">
            <button data-on={tab === "chat"} onClick={() => setTab("chat")}>
              Assistant
            </button>
            <button data-on={tab === "narration"} onClick={() => setTab("narration")}>
              Narration
            </button>
          </div>
        ) : (
          <h3 className="serif m-0 text-[21px]">Assistant</h3>
        )}
      </div>

      {tab === "narration" && props.narration ? (
        <div className="min-h-0 overflow-auto px-4 pb-4 pt-1.5">{props.narration}</div>
      ) : (
        <div ref={feed} className="flex min-h-0 flex-col gap-4 overflow-auto px-4 pb-4 pt-1.5">
          {props.turns.length === 0 && (
            <div className="mt-6 text-center text-[13px] text-muted">
              Describe what you want, or click <b className="font-medium text-ink-2">Select</b> and pick something in the preview to change it.
            </div>
          )}
          {props.turns.map((t) => (
            <div key={t.turnId} className="flex flex-col gap-1 animate-in">
              <div className="max-w-[90%] self-end rounded-[14px_14px_4px_14px] bg-ink px-3 py-2 text-[13px] text-white">
                {t.selection && <span className="mr-1 inline-block rounded bg-white/15 px-1.5 font-mono text-[10.5px]">{t.selection.part}</span>}
                {t.text}
              </div>
              <div className="text-[13px] text-ink-2">
                <Activity turn={t} />
                {t.approvals?.map((a) => (
                  <ApprovalCard key={a.requestId} projectId={props.projectId} approval={a} />
                ))}
                {t.reply && <Markdown text={t.reply.trim()} />}
                {t.notices?.map((n) => (
                  <div key={n} className="mt-1 rounded-lg bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
                    {n}
                  </div>
                ))}
                {t.status === "error" &&
                  (t.error === "Stopped." ? (
                    <div className="mt-1 text-[12px] text-muted">Stopped. Anything it changed so far is kept; use Undo to roll it back.</div>
                  ) : (
                    <div className="mt-1 rounded-lg bg-bad-soft px-2.5 py-1.5 text-[12px] text-bad">{t.error}</div>
                  ))}
              </div>
            </div>
          ))}
          {props.error && <div className="rounded-lg bg-bad-soft px-2.5 py-1.5 text-[12px] text-bad">{props.error}</div>}
        </div>
      )}

      <div className="px-3.5 pb-3.5 pt-1">
        {/* One clear undo for the last change (and redo right after) */}
        {(canUndo || undone) && (
          <div className="mb-1.5 flex items-center gap-2 px-1 text-[12px] text-muted animate-in">
            {undone ? (
              <>
                <span className="min-w-0 flex-1 truncate">Undid “{undone.message}”</span>
                <button className="rounded-md px-2 py-0.5 font-medium text-ink-2 hover:bg-black/5" disabled={undoBusy} onClick={() => void redo()}>
                  Redo
                </button>
              </>
            ) : (
              <>
                <span className="flex-1" />
                <button className="flex items-center gap-1.5 rounded-md px-2 py-0.5 font-medium text-ink-2 hover:bg-black/5" disabled={undoBusy} onClick={() => void undo()}>
                  <Undo size={13} /> Undo last change
                </button>
              </>
            )}
          </div>
        )}
        <div className="rounded-[14px] bg-surface p-2.5 pb-1.5 shadow-2">
          {(props.selection || props.sceneLabel) && (
            <div className="mb-1 flex flex-wrap gap-1.5">
              {props.selection ? (
                <span className="chip flex items-center gap-1 bg-[#FFF7D1] text-[#7A6200]">
                  {props.selection.part}
                  {props.selection.time !== undefined && ` · ${props.selection.time.toFixed(1)}s`}
                  <button className="ml-0.5 opacity-60 hover:opacity-100" onClick={props.onClearSelection}>
                    ✕
                  </button>
                </span>
              ) : (
                <span className="chip bg-accent-soft text-accent">{props.sceneLabel}</span>
              )}
            </div>
          )}
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder={props.busy ? "Working… you can type your next request" : props.selection ? `What should change about ${props.selection.part}?` : "Describe a change…"}
            className="w-full resize-none bg-transparent px-0.5 text-[13px] outline-none placeholder:text-faint"
          />
          <div className="flex items-end gap-1">
            <div className="min-w-0 flex-1">
              <AgentControls
                value={props.agent}
                providers={props.providers}
                onChange={props.onAgentChange}
                lockProvider={props.turns.length > 0}
                onMakeDefault={(a) => void studio.agents.setDefaults(a)}
                placement="up"
              />
            </div>
            {props.busy ? (
              <button className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px] bg-bad-soft text-bad" title="Stop" onClick={() => void studio.agents.interrupt(props.projectId)}>
                <Stop />
              </button>
            ) : (
              <button className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px] bg-ink text-white disabled:opacity-30" disabled={!text.trim()} onClick={submit} title="Send (Enter)">
                <ArrowUp size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
