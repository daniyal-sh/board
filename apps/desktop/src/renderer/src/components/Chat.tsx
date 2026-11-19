import { useEffect, useRef, useState } from "react";
import type { AgentProviderId, ChatTurn, ProviderStatus, Selection } from "@studio/shared";
import { studio } from "../lib/api";
import { ArrowUp, Check, Stop } from "./Icons";
import { Markdown } from "./Markdown";

const PROVIDER_COLOR: Record<AgentProviderId, string> = { claude: "#D97757", codex: "#17171C" };

function Steps({ steps }: { steps: ChatTurn["steps"] }) {
  if (!steps.length) return null;
  // Collapse runs of identical labels ("Editing", "Editing", …) into one row with the latest detail.
  const rows: (ChatTurn["steps"][number] & { count: number })[] = [];
  for (const s of steps) {
    const last = rows[rows.length - 1];
    if (last && last.label === s.label && last.status !== "error") {
      last.count++;
      last.detail = s.detail ?? last.detail;
      last.status = s.status === "running" ? "running" : last.status === "running" ? "done" : last.status;
    } else rows.push({ ...s, count: 1 });
  }
  return (
    <div className="mt-1 rounded-xl bg-surface px-3 pb-px pt-2.5 shadow-1">
      {rows.map((s, i) => (
        <div key={s.stepId} className="relative grid grid-cols-[16px_1fr] gap-2.5 pb-2.5 text-[12.5px] text-ink">
          {i < rows.length - 1 && <span className="absolute bottom-0 left-[7.5px] top-[18px] w-px bg-line" />}
          {s.status === "running" ? (
            <span className="spinner mt-px h-4 w-4" />
          ) : (
            <span className={`mt-px grid h-4 w-4 place-items-center rounded-full ${s.status === "error" ? "bg-bad-soft text-bad" : "bg-good-soft text-good"}`}>
              {s.status === "error" ? "!" : <Check size={10} />}
            </span>
          )}
          <div className="min-w-0">
            {s.label}
            {s.count > 1 && <span className="text-muted"> ×{s.count}</span>}
            {s.detail && <small className="block truncate text-[11.5px] text-muted">{s.detail}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Chat(props: {
  projectId: string;
  provider: AgentProviderId;
  providers: ProviderStatus[] | null;
  turns: ChatTurn[];
  busy: boolean;
  error: string | null;
  selection: Selection | null;
  sceneLabel?: string;
  onClearSelection: () => void;
  onSend: (text: string) => void;
  onProviderChange: (p: AgentProviderId) => void;
  /** Narration panel for videos and web animations. */
  narration?: React.ReactNode;
}) {
  const [text, setText] = useState("");
  const [tab, setTab] = useState<"chat" | "narration">("chat");
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: "smooth" });
  }, [props.turns]);

  useEffect(() => {
    if (props.selection) input.current?.focus();
  }, [props.selection]);

  function submit() {
    const t = text.trim();
    if (!t || props.busy) return;
    props.onSend(t);
    setText("");
  }

  const available = props.providers?.filter((p) => p.installed) ?? [];

  return (
    <aside className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] border-l border-line bg-white/40">
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
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-ink-2 hover:bg-black/5">
          <span className="grid h-4 w-4 place-items-center rounded-[5px] text-[9px] font-bold text-white" style={{ background: PROVIDER_COLOR[props.provider] }}>
            {props.provider === "claude" ? "C" : "◎"}
          </span>
          <select
            className="cursor-pointer bg-transparent outline-none"
            value={props.provider}
            disabled={props.busy}
            onChange={(e) => props.onProviderChange(e.target.value as AgentProviderId)}
          >
            {(available.length ? available : [{ id: props.provider, label: props.provider }]).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {tab === "narration" && props.narration ? (
        <div className="min-h-0 overflow-auto px-4 pb-4 pt-1.5">{props.narration}</div>
      ) : (
      <div ref={feed} className="flex min-h-0 flex-col gap-3.5 overflow-auto px-4 pb-4 pt-1.5">
        {props.turns.length === 0 && (
          <div className="mt-6 text-center text-[13px] text-muted">
            Describe what you want, or click <b className="font-medium text-ink-2">Select</b> and pick something in the preview to change it.
          </div>
        )}
        {props.turns.map((t) => (
          <div key={t.turnId} className="flex flex-col gap-2 animate-in">
            <div className="max-w-[90%] self-end rounded-[14px_14px_4px_14px] bg-ink px-3 py-2 text-[13px] text-white">
              {t.selection && <span className="mr-1 inline-block rounded bg-white/15 px-1.5 font-mono text-[10.5px]">{t.selection.part}</span>}
              {t.text}
            </div>
            <div className="text-[13px] text-ink-2">
              {t.reply && (
                <div className="mb-2">
                  <Markdown text={t.reply.trim()} />
                </div>
              )}
              <Steps steps={t.steps} />
              {t.status === "running" && !t.steps.length && !t.reply && (
                <div className="flex items-center gap-2 text-muted">
                  <span className="spinner" /> Thinking…
                </div>
              )}
              {t.status === "error" && <div className="mt-2 rounded-lg bg-bad-soft px-2.5 py-1.5 text-[12px] text-bad">{t.error}</div>}
              {t.status === "done" && t.commit && (
                <div className="mt-2 flex gap-1.5">
                  <button className="btn btn-ghost btn-sm" onClick={() => void studio.projects.undo(props.projectId)}>
                    Undo this
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {props.error && <div className="rounded-lg bg-bad-soft px-2.5 py-1.5 text-[12px] text-bad">{props.error}</div>}
      </div>
      )}

      <div className="px-3.5 pb-3.5 pt-2.5">
        <div className="rounded-[14px] bg-surface p-2.5 pb-2 shadow-2">
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
              props.sceneLabel && <span className="chip bg-accent-soft text-accent">{props.sceneLabel}</span>
            )}
          </div>
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
            placeholder={props.selection ? `What should change about ${props.selection.part}?` : "Describe a change…"}
            className="w-full resize-none bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
          <div className="flex items-center">
            <span className="text-[11px] text-faint">Enter to send · Shift+Enter for a new line</span>
            <span className="flex-1" />
            {props.busy ? (
              <button className="grid h-[30px] w-[30px] place-items-center rounded-[9px] bg-bad-soft text-bad" title="Stop" onClick={() => void studio.agents.interrupt(props.projectId)}>
                <Stop />
              </button>
            ) : (
              <button className="grid h-[30px] w-[30px] place-items-center rounded-[9px] bg-ink text-white disabled:opacity-40" disabled={!text.trim()} onClick={submit}>
                <ArrowUp size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
