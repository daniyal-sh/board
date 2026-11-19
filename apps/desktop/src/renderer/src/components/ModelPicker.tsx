import { useEffect, useRef, useState } from "react";
import type { AgentProviderId, AgentSettings, ModelOption, ProviderModels, ProviderStatus } from "@studio/shared";
import { studio } from "../lib/api";
import { Check, Refresh } from "./Icons";

const PROVIDERS: { id: AgentProviderId; label: string; color: string; glyph: string }[] = [
  { id: "claude", label: "Claude Code", color: "#D97757", glyph: "C" },
  { id: "codex", label: "Codex", color: "#17171C", glyph: "◎" },
];

const EFFORT_LABEL: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
export const effortLabel = (e: string) => EFFORT_LABEL[e] ?? e.charAt(0).toUpperCase() + e.slice(1);

/** Model lists are shared by every picker on screen. */
const lists = new Map<AgentProviderId, Promise<ProviderModels>>();
function loadModels(provider: AgentProviderId, refresh = false): Promise<ProviderModels> {
  if (refresh || !lists.has(provider)) lists.set(provider, studio.agents.models(provider, refresh));
  return lists.get(provider)!;
}

/** Keep settings valid for the chosen model (drop an effort or fast mode it doesn't offer). */
function normalize(s: AgentSettings, model?: ModelOption): AgentSettings {
  if (!model) return s;
  return {
    ...s,
    effort: s.effort && model.efforts.includes(s.effort) ? s.effort : undefined,
    fast: model.fast ? s.fast : false,
  };
}

export function ModelPicker(props: {
  value: AgentSettings;
  providers: ProviderStatus[] | null;
  onChange: (s: AgentSettings) => void;
  disabled?: boolean;
  /** Offer "use for new projects" (shown inside a project). */
  onMakeDefault?: (s: AgentSettings) => void;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ProviderModels | null>(null);
  const [loading, setLoading] = useState(false);
  const [savedDefault, setSavedDefault] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const v = props.value;
  const provider = PROVIDERS.find((p) => p.id === v.provider)!;
  const all = data?.provider === v.provider ? data.models : [];
  // Claude lists its own "default" entry; it's shown as the picker's Default row instead.
  const providerDefault = all.find((m) => m.id === "default");
  const models = all.filter((m) => m.id !== "default");
  const model = models.find((m) => m.id === v.model) ?? (!v.model ? providerDefault : undefined);

  async function load(refresh = false) {
    setLoading(true);
    try {
      setData(await loadModels(v.provider, refresh));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [v.provider]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    setSavedDefault(false);
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const set = (patch: Partial<AgentSettings>) => {
    const next = { ...v, ...patch };
    props.onChange(normalize(next, models.find((m) => m.id === next.model)));
  };

  const status = (id: AgentProviderId) => props.providers?.find((p) => p.id === id);
  const modelName = v.model && v.model !== "default" ? (model?.label ?? v.model) : "Default";
  const effortShown = v.effort ? effortLabel(v.effort) : undefined;

  return (
    <div ref={ref} className="relative">
      <button
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-ink-2 hover:bg-black/5 disabled:opacity-50"
        disabled={props.disabled}
        onClick={() => setOpen((o) => !o)}
        title="Choose the assistant, model, reasoning and speed"
      >
        <span className="grid h-4 w-4 flex-none place-items-center rounded-[5px] text-[9px] font-bold text-white" style={{ background: provider.color }}>
          {provider.glyph}
        </span>
        <span className="max-w-[150px] truncate font-medium text-ink">{modelName}</span>
        {effortShown && <span className="text-muted">· {effortShown}</span>}
        {v.fast && <span title="Fast mode" className="text-[#E8A33D]">⚡</span>}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          className={`absolute top-9 z-30 w-[340px] rounded-2xl bg-surface p-3 shadow-[0_20px_50px_-12px_rgba(0,0,0,.35),0_0_0_1px_rgba(0,0,0,.06)] animate-in ${props.align === "left" ? "left-0" : "right-0"}`}
        >
          {/* Harness */}
          <div className="grid grid-cols-2 gap-1.5">
            {PROVIDERS.map((p) => {
              const st = status(p.id);
              const usable = st?.installed && st.authenticated !== false;
              return (
                <button
                  key={p.id}
                  disabled={!usable}
                  onClick={() => p.id !== v.provider && props.onChange({ provider: p.id })}
                  className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-left disabled:opacity-45"
                  style={v.provider === p.id ? { boxShadow: "inset 0 0 0 2px var(--color-ink)", background: "#fff" } : { background: "var(--color-surface-2)" }}
                >
                  <span className="grid h-6 w-6 flex-none place-items-center rounded-[7px] text-[11px] font-bold text-white" style={{ background: p.color }}>
                    {p.glyph}
                  </span>
                  <span className="min-w-0">
                    <b className="block text-[12.5px] font-semibold">{p.label}</b>
                    <small className="block truncate text-[10.5px] text-muted">{!st ? "Checking…" : !st.installed ? "Not installed" : st.authenticated === false ? "Not signed in" : "Your subscription"}</small>
                  </span>
                </button>
              );
            })}
          </div>

          {/* Model */}
          <div className="mb-1 mt-3 flex items-center">
            <span className="eyebrow">Model</span>
            <span className="flex-1" />
            <button className="flex items-center gap-1 text-[11px] text-muted hover:text-ink" onClick={() => void load(true)} title="Ask the CLI again">
              <Refresh size={11} /> {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
          <div className="max-h-[230px] overflow-auto rounded-xl bg-surface-2 p-1">
            <ModelRow active={!v.model || v.model === "default"} label="Default" description={providerDefault?.description ?? `Whatever ${provider.label} uses by default`} fast={Boolean(providerDefault?.fast)} onClick={() => set({ model: undefined })} />
            {models.map((m) => (
              <ModelRow key={m.id} active={v.model === m.id} label={m.label} description={m.description} fast={Boolean(m.fast)} onClick={() => set({ model: m.id })} />
            ))}
            {loading && !models.length && <div className="flex items-center gap-2 px-2.5 py-3 text-[12px] text-muted"><span className="spinner" /> Asking {provider.label} which models you can use…</div>}
            {data?.error && !models.length && <div className="px-2.5 py-2 text-[11.5px] text-bad">{data.error}</div>}
          </div>

          {/* Reasoning */}
          {(model?.efforts.length ?? 0) > 0 || !model ? (
            <>
              <div className="eyebrow mb-1 mt-3">Reasoning</div>
              <div className="flex flex-wrap gap-1">
                <Chip active={!v.effort} onClick={() => set({ effort: undefined })}>
                  Auto{model?.defaultEffort ? ` (${effortLabel(model.defaultEffort)})` : ""}
                </Chip>
                {(model?.efforts ?? ["low", "medium", "high", "xhigh", "max"]).map((e) => (
                  <Chip key={e} active={v.effort === e} onClick={() => set({ effort: e })}>
                    {effortLabel(e)}
                  </Chip>
                ))}
              </div>
              <p className="mb-0 mt-1 text-[11px] leading-snug text-muted">More reasoning is slower but better for tricky maths and long builds.</p>
            </>
          ) : null}

          {/* Speed */}
          {(!model || model.fast) && (
            <label className="mt-3 flex cursor-pointer items-center gap-2.5 rounded-xl bg-surface-2 px-2.5 py-2">
              <span className="text-[15px]">⚡</span>
              <span className="min-w-0 flex-1">
                <b className="block text-[12.5px] font-semibold">{model?.fast?.label ?? "Fast mode"}</b>
                <small className="block text-[11px] text-muted">{model?.fast?.description ?? "Faster responses, where the model supports it"}</small>
              </span>
              <button
                role="switch"
                aria-checked={Boolean(v.fast)}
                onClick={() => set({ fast: !v.fast })}
                className="relative h-[19px] w-8 flex-none rounded-full transition"
                style={{ background: v.fast ? "var(--color-ink)" : "#DCD9D2" }}
              >
                <span className="absolute top-[2px] h-[15px] w-[15px] rounded-full bg-white shadow transition-all" style={{ left: v.fast ? 15 : 2 }} />
              </button>
            </label>
          )}

          {props.onMakeDefault && (
            <button
              className="mt-3 w-full rounded-lg py-1.5 text-[12px] text-ink-2 hover:bg-black/5"
              onClick={() => {
                props.onMakeDefault!(v);
                setSavedDefault(true);
              }}
            >
              {savedDefault ? "✓ New projects will use this" : "Use this for new projects"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ModelRow(props: { active: boolean; label: string; description?: string; fast?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-white"
      style={props.active ? { background: "#fff", boxShadow: "var(--shadow-1)" } : undefined}
    >
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[12.5px] font-medium">
          {props.label}
          {props.fast && <span className="ml-1.5 text-[10px] font-normal text-[#9A6418]">⚡ fast</span>}
        </b>
        {props.description && <small className="block truncate text-[11px] text-muted">{props.description}</small>}
      </span>
      {props.active && <Check size={13} className="flex-none text-accent" />}
    </button>
  );
}

function Chip(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      className="rounded-full px-2.5 py-1 text-[11.5px] font-medium"
      style={props.active ? { background: "var(--color-ink)", color: "#fff" } : { background: "var(--color-surface-2)", color: "var(--color-ink-2)", boxShadow: "inset 0 0 0 1px var(--color-line)" }}
    >
      {props.children}
    </button>
  );
}
