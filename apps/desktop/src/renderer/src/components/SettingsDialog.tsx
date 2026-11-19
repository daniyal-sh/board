import { useEffect, useState } from "react";
import type { ProviderStatus, VideoEnvStatus } from "@studio/shared";
import { errorMessage, studio } from "../lib/api";
import { Modal } from "./Modal";

function Dot({ ok, label }: { ok: boolean | undefined; label: string }) {
  return <span className={`text-[11.5px] font-medium ${ok ? "text-good" : "text-warn"}`}>● {label}</span>;
}

export function SettingsDialog(props: { onClose: () => void; onProviders: (p: ProviderStatus[]) => void }) {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [env, setEnv] = useState<VideoEnvStatus | null>(null);
  const [setupLog, setSetupLog] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState("");

  async function refresh() {
    const p = await studio.agents.status(true);
    setProviders(p);
    props.onProviders(p);
  }

  useEffect(() => {
    void refresh();
    void studio.video.status().then(setEnv);
    void studio.app.info().then((i) => setDir(i.projectsDir));
    return studio.video.onSetupProgress((p) => setSetupLog(p.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal title="Settings" onClose={props.onClose} width={500}>
      <div className="eyebrow mb-1 mt-1">Assistants · your own subscriptions</div>
      {!providers && <div className="spinner my-3" />}
      {providers?.map((p) => (
        <div key={p.id} className="flex items-center gap-3 border-t border-line-2 py-3 first-of-type:border-0">
          <span className="grid h-8 w-8 flex-none place-items-center rounded-[9px] text-[12px] font-bold text-white" style={{ background: p.id === "claude" ? "#D97757" : "#3F3F46" }}>
            {p.id === "claude" ? "C" : "◎"}
          </span>
          <div className="min-w-0 flex-1">
            <b className="font-medium">{p.label}</b>
            <small className="block text-[12px] text-muted">{p.installed ? `${p.version ?? ""} · ${p.message ?? "signed in"}` : p.message}</small>
          </div>
          <Dot ok={p.installed && p.authenticated !== false} label={!p.installed ? "Not installed" : p.authenticated === false ? "Sign in" : "Ready"} />
        </div>
      ))}
      <button className="btn btn-ghost btn-sm mt-1" onClick={() => void refresh()}>
        Check again
      </button>

      <div className="eyebrow mb-1 mt-5">Rendering</div>
      <div className="flex items-center gap-3 border-t border-line-2 py-3 first-of-type:border-0">
        <span className="grid h-8 w-8 flex-none place-items-center rounded-[9px] bg-context-soft text-[12px] font-bold text-context">CE</span>
        <div className="flex-1">
          <b className="font-medium">Manim Community + LaTeX</b>
          <small className="block text-[12px] text-muted">{installing ? setupLog ?? "Installing…" : "For videos. Installed into the app's own folder."}</small>
        </div>
        {env?.ready && env.latex ? (
          <Dot ok label="Ready" />
        ) : (
          <button
            className="btn btn-sm btn-dark"
            disabled={installing}
            onClick={async () => {
              setInstalling(true);
              setError(null);
              try {
                setEnv(await studio.video.setup());
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setInstalling(false);
              }
            }}
          >
            {installing ? "Installing…" : "Install"}
          </button>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-line-2 py-3">
        <span className="grid h-8 w-8 flex-none place-items-center rounded-[9px] bg-good-soft text-[12px] font-bold text-good">W</span>
        <div className="flex-1">
          <b className="font-medium">manim-web and Lab libraries</b>
          <small className="block text-[12px] text-muted">Built in. Works offline.</small>
        </div>
        <Dot ok label="Ready" />
      </div>
      {error && <div className="mt-2 whitespace-pre-wrap rounded-lg bg-bad-soft p-2.5 text-[12px] text-bad">{error}</div>}

      <div className="eyebrow mb-1 mt-5">Projects folder</div>
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate font-mono text-[12px] text-ink-2">{dir}</span>
        <button className="btn btn-sm" onClick={() => void studio.app.showInFolder(dir)}>
          Open
        </button>
      </div>
      <p className="mb-0 mt-4 text-[12px] text-muted">Everything stays on this computer. No account, nothing uploaded; only your assistant (Claude Code or Codex) talks to its own service.</p>
    </Modal>
  );
}
