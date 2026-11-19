import { useEffect, useState } from "react";
import { BRAND, type AgentRequest, type CreateProjectInput, type ProviderStatus } from "@studio/shared";
import { errorMessage, studio } from "./lib/api";
import { Home, ProjectsPage } from "./components/Home";
import { Studio } from "./components/Studio";
import { SettingsDialog } from "./components/SettingsDialog";
import { Lockup } from "./components/Brand";
import { ProviderLogo } from "./components/ProviderLogo";
import { GearIcon, Grid, HomeIcon, Moon, Sun } from "./components/Icons";

type Route =
  | { view: "home" }
  | { view: "projects" }
  | { view: "project"; id: string; firstPrompt?: string; intro?: AgentRequest["intro"] };

type Theme = "light" | "dark" | "system";
const THEME_KEY = "board.theme";

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** Light, dark or follow the computer; applied as html.dark like Apollo. */
function useTheme(): [boolean, () => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const [systemDark, setSystemDark] = useState(media.matches);
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener("change", on);
    return () => media.removeEventListener("change", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const dark = theme === "dark" || (theme === "system" && systemDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  const toggle = () => {
    const next: Theme = dark ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode */
    }
  };
  return [dark, toggle];
}

export function App() {
  const [route, setRoute] = useState<Route>({ view: "home" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [dark, toggleTheme] = useTheme();

  useEffect(() => {
    void studio.agents.status().then(setProviders);
  }, []);

  async function create(input: CreateProjectInput, intro?: AgentRequest["intro"]) {
    setCreating(true);
    setCreateError(null);
    try {
      const p = await studio.projects.create(input);
      setRoute({ view: "project", id: p.manifest.id, firstPrompt: input.prompt, intro });
    } catch (e) {
      setCreateError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  const open = (id: string) => setRoute({ view: "project", id });
  const settings = settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onProviders={setProviders} />;

  // A project is a focused workspace: no sidebar, one slim bar (like solving in Apollo).
  if (route.view === "project") {
    return (
      <>
        <Studio
          key={route.id}
          projectId={route.id}
          firstPrompt={route.firstPrompt}
          intro={route.intro}
          providers={providers}
          dark={dark}
          onToggleTheme={toggleTheme}
          onBack={() => setRoute({ view: "home" })}
          onDeleted={() => setRoute({ view: "home" })}
        />
        {settings}
      </>
    );
  }

  const title = route.view === "home" ? "Home" : "Projects";
  return (
    <div className="grid h-full grid-cols-[240px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-r border-line bg-surface">
        <div className="flex h-[52px] flex-none items-center border-b border-line px-5">
          <Lockup size={17} />
        </div>
        <nav className="flex-1 overflow-auto px-3.5 pt-5" aria-label="Workspace">
          <div className="mb-1.5 px-2.5 text-[12px] font-medium text-muted">Create</div>
          <button className="nav-item" data-on={route.view === "home"} onClick={() => setRoute({ view: "home" })}>
            <HomeIcon size={16} /> Home
          </button>
          <button className="nav-item" data-on={route.view === "projects"} onClick={() => setRoute({ view: "projects" })}>
            <Grid size={16} /> Projects
          </button>
          <div className="mb-1.5 mt-6 px-2.5 text-[12px] font-medium text-muted">App</div>
          <button className="nav-item" onClick={() => setSettingsOpen(true)}>
            <GearIcon size={16} /> Settings
          </button>
        </nav>
        <button className="mx-3.5 mb-3.5 grid gap-1.5 rounded-[12px] border border-line p-3 text-left text-[12.5px] transition-colors hover:bg-surface-2" onClick={() => setSettingsOpen(true)}>
          <span className="text-[12px] font-medium text-muted">Assistants on this computer</span>
          {(providers ?? []).map((p) => {
            const ok = p.installed && p.authenticated !== false;
            return (
              <span key={p.id} className={`flex items-center gap-2 ${ok ? "text-ink" : "text-muted"}`}>
                <ProviderLogo provider={p.id} size={14} />
                {p.label}
                {!ok && <span className="ml-auto text-[12px] text-warn">{!p.installed ? "Not installed" : "Not signed in"}</span>}
              </span>
            );
          })}
          {providers === null && <span className="text-muted">Checking…</span>}
        </button>
        <div className="border-t border-line px-5 py-2.5 text-[11.5px] text-muted">
          By the Apollo team ·{" "}
          <button className="font-medium text-accent-ink hover:underline" onClick={() => void studio.app.openExternal(BRAND.website)}>
            {BRAND.website.replace(/^https?:\/\//, "")}
          </button>
        </div>
      </aside>

      <div className="grid min-h-0 grid-rows-[52px_minmax(0,1fr)]">
        <header className="flex items-center gap-2 border-b border-line bg-surface px-6" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
          <span className="flex-1 text-[14px] font-semibold">{title}</span>
          <span className="flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <button className="icon-btn" title={dark ? "Light theme" : "Dark theme"} onClick={toggleTheme}>
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
              <GearIcon size={17} />
            </button>
          </span>
        </header>
        <main className="min-h-0">
          {route.view === "home" ? (
            <Home
              providers={providers}
              creating={creating}
              error={createError}
              onCreate={create}
              onOpen={open}
              onOpenSettings={() => setSettingsOpen(true)}
              onAllProjects={() => setRoute({ view: "projects" })}
            />
          ) : (
            <ProjectsPage onOpen={open} onNew={() => setRoute({ view: "home" })} />
          )}
        </main>
      </div>
      {settings}
    </div>
  );
}
