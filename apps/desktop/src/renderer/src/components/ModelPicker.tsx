import { useEffect, useRef, useState } from "react";
import { DEFAULT_ACCESS, type AccessLevel, type AgentProviderId, AgentSettings, ModelOption, ProviderModels, ProviderStatus } from "@studio/shared";
import { studio } from "../lib/api";
import { Check, Refresh } from "./Icons";
import { ProviderLogo } from "./ProviderLogo";

/**
 * Assistant controls in the style of Codex / Claude Code: a model menu, a reasoning menu and a
 * fast-mode toggle, sitting in the chat bar. The harness (Claude Code / Codex) can be chosen for a
 * new project; once a project has a conversation it's fixed, but model, reasoning and speed can
 * change at any time (they apply from the next message).
 */

export const PROVIDERS: { id: AgentProviderId; label: string; color: string; glyph: string }[] = [
  { id: "claude", label: "Claude Code", color: "#D97757", glyph: "C" },
  { id: "codex", label: "Codex", color: "#3F3F46", glyph: "◎" },
];

const EFFORTS: Record<string, { label: string; hint: string }> = {
  minimal: { label: "Minimal", hint: "Quickest replies" },
  low: { label: "Low", hint: "Quick, for small tweaks" },
  medium: { label: "Medium", hint: "Balanced" },
  high: { label: "High", hint: "Thinks more before answering" },
  xhigh: { label: "Extra high", hint: "For tricky maths and long builds" },
  max: { label: "Max", hint: "Thinks the longest; slowest" },
  ultra: { label: "Ultra", hint: "Deepest reasoning Codex offers" },
};
export const effortLabel = (e: string) => EFFORTS[e]?.label ?? e.charAt(0).toUpperCase() + e.slice(1);

/** Model lists are shared by every control on screen. */
const lists = new Map<AgentProviderId, Promise<ProviderModels>>();
function loadModels(provider: AgentProviderId, refresh = false): Promise<ProviderModels> {
  if (refresh || !lists.has(provider)) lists.set(provider, studio.agents.models(provider, refresh));
  return lists.get(provider)!;
}

function useModels(provider: AgentProviderId) {
  const [data, setData] = useState<ProviderModels | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async (refresh = false) => {
    setLoading(true);
    try {
      setData(await loadModels(provider, refresh));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = data?.provider === provider ? data.models : [];
  // Claude lists its own "default" entry; it's shown as our Default row instead.
  const providerDefault = all.find((m) => m.id === "default");
  return { models: all.filter((m) => m.id !== "default"), providerDefault, loading, error: data?.error, reload: () => load(true) };
}

/** Keep settings valid for the chosen model (drop an effort or fast mode it doesn't offer). */
function normalize(s: AgentSettings, model?: ModelOption): AgentSettings {
  if (!model) return s;
  return { ...s, effort: s.effort && model.efforts.includes(s.effort) ? s.effort : undefined, fast: model.fast ? s.fast : false };
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return { open, setOpen, ref };
}

const chipClass =
  "flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-ink-2 transition hover:bg-soft data-[open=true]:bg-soft";
const menuClass = "absolute z-40 rounded-xl bg-surface p-1.5 shadow-[0_18px_44px_-12px_rgba(0,0,0,.35),0_0_0_1px_rgba(0,0,0,.07)] animate-in";

function Caret() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="opacity-60">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function AgentControls(props: {
  value: AgentSettings;
  providers: ProviderStatus[] | null;
  onChange: (s: AgentSettings) => void;
  /** The project already has a conversation: the harness can't change. */
  lockProvider?: boolean;
  onMakeDefault?: (s: AgentSettings) => void;
  /** Menus open above (chat bar) or below (Home). */
  placement?: "up" | "down";
}) {
  const v = props.value;
  const { models, providerDefault, loading, error, reload } = useModels(v.provider);
  const model = models.find((m) => m.id === v.model) ?? (!v.model ? providerDefault : undefined);
  const provider = PROVIDERS.find((p) => p.id === v.provider)!;
  const pos = props.placement === "down" ? "top-9" : "bottom-9";
  const modelMenu = usePopover();
  const effortMenu = usePopover();
  const [savedDefault, setSavedDefault] = useState(false);

  const set = (patch: Partial<AgentSettings>) => {
    const next = { ...v, ...patch };
    props.onChange(normalize(next, models.find((m) => m.id === next.model) ?? (!next.model ? providerDefault : undefined)));
  };
  const modelName = v.model && v.model !== "default" ? (model?.label ?? v.model) : "Default";
  const efforts = model?.efforts ?? [];
  const status = (id: AgentProviderId) => props.providers?.find((p) => p.id === id);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5">
      {/* Model (and harness) */}
      <div ref={modelMenu.ref} className="relative">
        <button className={chipClass} data-open={modelMenu.open} onClick={() => modelMenu.setOpen((o) => !o)} title="Model">
          <ProviderLogo provider={provider.id} size={15} className="text-ink" />
          <span className="max-w-[130px] truncate font-medium text-ink">{modelName}</span>
          <Caret />
        </button>
        {modelMenu.open && (
          <div className={`${menuClass} ${pos} left-0 w-[300px]`}>
            {props.lockProvider ? (
              <div className="flex items-center gap-2 px-2 pb-1.5 pt-1 text-[11.5px] text-muted">
                <span className="font-semibold text-ink-2">{provider.label}</span>
                <span className="flex-1" />
                <span title="Each project keeps one assistant so its conversation stays together.">🔒 fixed for this project</span>
              </div>
            ) : (
              <div className="mb-1 grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-0.5">
                {PROVIDERS.map((p) => {
                  const st = status(p.id);
                  const usable = st?.installed && st.authenticated !== false;
                  return (
                    <button
                      key={p.id}
                      disabled={!usable}
                      onClick={() => p.id !== v.provider && props.onChange({ provider: p.id })}
                      title={!st ? "" : !st.installed ? "Not installed" : st.authenticated === false ? "Not signed in" : ""}
                      className="rounded-md py-1 text-[12px] font-medium disabled:opacity-40"
                      style={v.provider === p.id ? { background: "var(--color-surface)", boxShadow: "var(--shadow-1), 0 0 0 1px var(--color-line)", color: "var(--color-ink)" } : { color: "var(--color-ink-2)" }}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <ProviderLogo provider={p.id} size={13} />
                        {p.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="max-h-[300px] overflow-auto">
              <MenuItem
                active={!v.model || v.model === "default"}
                title="Default"
                subtitle={providerDefault?.description ?? `What ${provider.label} uses by default`}
                badge={providerDefault?.fast ? "⚡" : undefined}
                onClick={() => {
                  set({ model: undefined });
                  modelMenu.setOpen(false);
                }}
              />
              {models.map((m) => (
                <MenuItem
                  key={m.id}
                  active={v.model === m.id}
                  title={m.label}
                  subtitle={m.description}
                  badge={m.fast ? "⚡" : undefined}
                  onClick={() => {
                    set({ model: m.id });
                    modelMenu.setOpen(false);
                  }}
                />
              ))}
              {loading && !models.length && (
                <div className="flex items-center gap-2 px-2.5 py-2.5 text-[12px] text-muted">
                  <span className="spinner" /> Loading models…
                </div>
              )}
              {error && !models.length && <div className="px-2.5 py-2 text-[11.5px] text-bad">{error}</div>}
            </div>
            <div className="mt-1 flex items-center border-t border-line-2 px-1 pt-1">
              <button className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-soft hover:text-ink" onClick={() => void reload()}>
                <Refresh size={11} /> Refresh
              </button>
              <span className="flex-1" />
              {props.onMakeDefault && (
                <button
                  className="rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-soft hover:text-ink"
                  onClick={() => {
                    props.onMakeDefault!(v);
                    setSavedDefault(true);
                    setTimeout(() => setSavedDefault(false), 1800);
                  }}
                >
                  {savedDefault ? "✓ Saved as default" : "Use for new projects"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Reasoning */}
      {efforts.length > 0 && (
        <div ref={effortMenu.ref} className="relative">
          <button className={chipClass} data-open={effortMenu.open} onClick={() => effortMenu.setOpen((o) => !o)} title="Reasoning">
            <span className="whitespace-nowrap">{v.effort ? effortLabel(v.effort) : "Auto effort"}</span>
            <Caret />
          </button>
          {effortMenu.open && (
            <div className={`${menuClass} ${pos} ${props.placement === "down" ? "left-0" : "right-0"} w-[240px]`}>
              <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Reasoning</div>
              <MenuItem
                active={!v.effort}
                title={`Auto${model?.defaultEffort ? ` (${effortLabel(model.defaultEffort)})` : ""}`}
                subtitle="Let the model decide"
                onClick={() => {
                  set({ effort: undefined });
                  effortMenu.setOpen(false);
                }}
              />
              {efforts.map((e) => (
                <MenuItem
                  key={e}
                  active={v.effort === e}
                  title={effortLabel(e)}
                  subtitle={EFFORTS[e]?.hint}
                  onClick={() => {
                    set({ effort: e });
                    effortMenu.setOpen(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Access */}
      <AccessMenu value={v.access ?? DEFAULT_ACCESS} provider={provider.label} pos={pos} placement={props.placement} onChange={(access) => props.onChange({ ...v, access })} />

      {/* Fast mode */}
      {model?.fast && (
        <button
          className={chipClass}
          data-open={Boolean(v.fast)}
          onClick={() => set({ fast: !v.fast })}
          title={`${model.fast.label}: ${model.fast.description ?? "faster responses"} (${v.fast ? "on" : "off"})`}
          style={v.fast ? { color: "var(--color-warn)", background: "var(--color-warn-soft)" } : undefined}
        >
          ⚡{v.fast && <span className="font-medium">Fast</span>}
        </button>
      )}
    </div>
  );
}

const ACCESS: { id: AccessLevel; label: string; icon: string; hint: string }[] = [
  { id: "ask", label: "Ask first", icon: "✋", hint: "Edits files in this project. Asks before running commands, using the web, or touching anything else." },
  { id: "auto", label: "Auto", icon: "⚙", hint: "Also runs commands and uses the web without asking. Stays inside the project folder." },
  { id: "full", label: "Full access", icon: "⚠", hint: "No limits: can run anything and change any file on this computer. Use with care." },
];

function AccessMenu(props: { value: AccessLevel; provider: string; pos: string; placement?: "up" | "down"; onChange: (a: AccessLevel) => void }) {
  const menu = usePopover();
  const current = ACCESS.find((a) => a.id === props.value) ?? ACCESS[0];
  const danger = props.value === "full";
  return (
    <div ref={menu.ref} className="relative">
      <button
        className={chipClass}
        data-open={menu.open}
        onClick={() => menu.setOpen((o) => !o)}
        title={`Access: ${current.label}`}
        style={danger ? { color: "var(--color-bad)", background: "var(--color-bad-soft)" } : undefined}
      >
        <span className="text-[11px]">{current.icon}</span>
        <span className="whitespace-nowrap">{current.label}</span>
        <Caret />
      </button>
      {menu.open && (
        <div className={`${menuClass} ${props.pos} ${props.placement === "down" ? "left-0" : "right-0"} w-[290px]`}>
          <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">What {props.provider} may do</div>
          {ACCESS.map((a) => (
            <button
              key={a.id}
              onClick={() => {
                props.onChange(a.id);
                menu.setOpen(false);
              }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2"
            >
              <span className="mt-0.5 w-4 flex-none text-center text-[12px]">{a.icon}</span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[12.5px] font-medium ${a.id === "full" ? "text-bad" : "text-ink"}`}>{a.label}</span>
                <span className="block text-[11px] leading-snug text-muted">{a.hint}</span>
              </span>
              <span className="mt-0.5 w-3.5 flex-none">{props.value === a.id && <Check size={13} className="text-accent" />}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MenuItem(props: { active: boolean; title: string; subtitle?: string; badge?: string; onClick: () => void }) {
  return (
    <button onClick={props.onClick} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-ink">
          {props.title}
          {props.badge && <span className="ml-1.5 text-[10.5px]">{props.badge}</span>}
        </span>
        {props.subtitle && <span className="block truncate text-[11px] text-muted">{props.subtitle}</span>}
      </span>
      <span className="w-3.5 flex-none">{props.active && <Check size={13} className="text-accent" />}</span>
    </button>
  );
}
