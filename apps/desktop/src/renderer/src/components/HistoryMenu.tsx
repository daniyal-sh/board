import { useEffect, useRef, useState } from "react";
import type { HistoryEntry } from "@studio/shared";
import { studio, timeAgo } from "../lib/api";
import { History } from "./Icons";

/** Versions are git commits under the hood; teachers just see a list of changes. */
export function HistoryMenu(props: { projectId: string; disabled?: boolean; onRestored: () => void }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void studio.projects.history(props.projectId).then(setEntries);
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open, props.projectId]);

  return (
    <div ref={ref} className="relative">
      <button className="icon-btn" title="Versions" data-on={open} disabled={props.disabled} onClick={() => setOpen((v) => !v)}>
        <History size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-20 w-80 rounded-xl bg-surface p-1.5 shadow-2 animate-in">
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Versions</div>
          <div className="max-h-80 overflow-auto">
            {entries.map((e, i) => (
              <div key={e.id} className="group flex items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-surface-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px]">{e.message.replace(/^Turn: /, "")}</div>
                  <div className="text-[11px] text-muted">
                    {i === 0 ? "Current · " : ""}
                    {timeAgo(e.timestamp)}
                  </div>
                </div>
                {i > 0 && (
                  <button
                    className="btn btn-sm opacity-0 group-hover:opacity-100"
                    onClick={async () => {
                      await studio.projects.restore(props.projectId, e.id);
                      setOpen(false);
                      props.onRestored();
                    }}
                  >
                    Restore
                  </button>
                )}
              </div>
            ))}
            {!entries.length && <div className="px-2.5 py-3 text-muted">No versions yet.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
