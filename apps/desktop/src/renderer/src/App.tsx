import { useEffect, useState } from "react";
import { BRAND, type CreateProjectInput, type ProviderStatus } from "@studio/shared";
import { errorMessage, studio } from "./lib/api";
import { Home } from "./components/Home";
import { Studio } from "./components/Studio";
import { SettingsDialog } from "./components/SettingsDialog";
import { GearIcon, HomeIcon } from "./components/Icons";

type Route = { view: "home" } | { view: "project"; id: string; firstPrompt?: string };

export function App() {
  const [route, setRoute] = useState<Route>({ view: "home" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [title, setTitle] = useState<React.ReactNode>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    void studio.agents.status().then(setProviders);
  }, []);

  async function create(input: CreateProjectInput) {
    setCreating(true);
    setCreateError(null);
    try {
      const p = await studio.projects.create(input);
      setRoute({ view: "project", id: p.manifest.id, firstPrompt: input.prompt });
    } catch (e) {
      setCreateError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="grid h-full grid-rows-[48px_1fr]">
      <header className="flex items-center gap-3 border-b border-line bg-white/50 pl-4 pr-3" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button className="icon-btn" title="Home" onClick={() => setRoute({ view: "home" })}>
            <HomeIcon />
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-2.5 font-medium" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          {route.view === "home" ? <span>{BRAND.name}</span> : title}
        </div>
        <span className="flex-1" />
        <div id="titlebar-actions" className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
            <GearIcon />
          </button>
        </div>
      </header>

      <main className="min-h-0">
        {route.view === "home" ? (
          <Home
            providers={providers}
            creating={creating}
            error={createError}
            onCreate={create}
            onOpen={(id) => setRoute({ view: "project", id })}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : (
          <Studio
            key={route.id}
            projectId={route.id}
            firstPrompt={route.firstPrompt}
            providers={providers}
            onTitle={setTitle}
            onDeleted={() => setRoute({ view: "home" })}
          />
        )}
      </main>

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onProviders={setProviders}
        />
      )}
    </div>
  );
}
