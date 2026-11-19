import "./early-env";
import fs from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { BRAND, IPC, type AgentEvent, type AgentProviderId, type AgentSettings, type CreateProjectInput, type PublishRequest, type Selection, type Visibility } from "@studio/shared";
import { providerStatus } from "./agents/detect";
import { agentDefaults, providerModels, setAgentDefaults } from "./agents/models";
import { interruptAgent, sendToAgent } from "./agents/manager";
import { setSelection, startToolServer } from "./agents/tools";
import { buildExport, buildPreview, handlePreviewProtocol, registerPreviewScheme, PREVIEW_SCHEME } from "./build/preview";
import { listHistory, restoreTo, undoLast } from "./history";
import { ensureLabKit, paths } from "./paths";
import { projects } from "./projects";
import * as cloud from "./publish";
import { setupVideoEnv, videoEnvStatus, manimEnv, runtime } from "./video/env";
import { video } from "./video/renderer";
import * as voice from "./voice";
import { spawn } from "node:child_process";

registerPreviewScheme();
app.setName(BRAND.name);

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#F3F1EC",
    title: BRAND.name,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: paths.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(paths.rendererHtml);
}

function emit(e: AgentEvent): void {
  win?.webContents.send(IPC.agentEvent, e);
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as A)));
}

/** Scenes follow the voice: re-render (video) or rebuild (web) once narration changes. */
async function afterNarration(id: string, scene: string, progress: (m: string) => void): Promise<void> {
  if (projects.manifest(id).kind === "video" && videoEnvStatus().ready) {
    progress("Re-timing the scene to your narration…");
    await video.renderPreview(id, scene);
  }
  emit({ type: "preview.updated", projectId: id });
}

function registerIpc(): void {
  handle(IPC.appInfo, () => ({ version: app.getVersion(), platform: process.platform, projectsDir: paths.projectsDir }));
  handle(IPC.openExternal, (url: string) => {
    if (/^(https?:|mailto:)/.test(url)) return shell.openExternal(url);
  });
  handle(IPC.showInFolder, (p: string) => shell.showItemInFolder(p));

  handle(IPC.agentsStatus, (refresh?: boolean) => providerStatus(refresh));
  handle(IPC.agentSend, (req) => sendToAgent(req as Parameters<typeof sendToAgent>[0], emit));
  handle(IPC.agentInterrupt, (id: string) => interruptAgent(id));
  handle(IPC.agentSelection, (id: string, sel: Selection | null) => setSelection(id, sel ?? undefined));
  handle(IPC.agentModels, (provider: AgentProviderId, refresh?: boolean) => providerModels(provider, refresh));
  handle(IPC.agentSettings, (id: string, settings: AgentSettings) => {
    const m = projects.manifest(id);
    // A thread belongs to one provider; switching providers starts a fresh conversation there.
    projects.saveManifest({ ...m, agent: settings });
  });
  handle(IPC.agentDefaults, () => agentDefaults());
  handle(IPC.agentSetDefaults, (settings: AgentSettings) => setAgentDefaults(settings));

  handle(IPC.projectsList, () => projects.list());
  handle(IPC.projectsCreate, (input: CreateProjectInput) => projects.create(input));
  handle(IPC.projectsOpen, (id: string) => projects.open(id));
  handle(IPC.projectsRename, (id: string, title: string) => projects.rename(id, title));
  handle(IPC.projectsRemove, (id: string) => projects.remove(id));
  handle(IPC.projectsHistory, (id: string) => listHistory(projects.dir(id)));
  handle(IPC.projectsRestore, async (id: string, oid: string) => {
    await restoreTo(projects.dir(id), oid, `Restored an earlier version`);
    emit({ type: "preview.updated", projectId: id });
  });
  handle(IPC.projectsUndo, async (id: string) => {
    await undoLast(projects.dir(id));
    emit({ type: "preview.updated", projectId: id });
  });

  handle(IPC.buildPreview, async (id: string, sceneId?: string) => {
    if (projects.manifest(id).kind !== "video") return buildPreview(id);
    const r = await video.renderPreview(id, sceneId);
    return { ok: r.ok, errors: r.ok ? [] : [r.log] };
  });
  handle(IPC.buildExportHtml, async (id: string) => {
    const m = projects.manifest(id);
    const built = await buildExport(id);
    const res = await dialog.showSaveDialog(win!, {
      title: "Save as a single HTML file",
      defaultPath: join(app.getPath("downloads"), `${projects.dir(id).split(/[\\/]/).pop()}.html`),
      filters: [{ name: "Web page", extensions: ["html"] }],
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, built.html);
    void m;
    return { path: res.filePath };
  });

  handle(IPC.buildCopyHtml, async (id: string) => {
    const built = await buildExport(id);
    clipboard.writeText(built.html);
    return { sizeBytes: built.sizeBytes };
  });

  handle(IPC.videoStatus, () => videoEnvStatus());
  handle(IPC.videoSetup, () =>
    setupVideoEnv((step, message) => win?.webContents.send(IPC.videoSetupProgress, { step, message })),
  );
  handle(IPC.videoSceneUrl, (id: string, sceneId: string) => {
    const f = join(projects.dir(id), "build", "scenes", `${sceneId}.mp4`);
    return fs.existsSync(f) ? `${PREVIEW_SCHEME}://${id}/scenes/${sceneId}.mp4?v=${fs.statSync(f).mtimeMs}` : null;
  });
  handle(IPC.videoTimeline, (id: string, sceneId: string) => video.timeline(id, sceneId) ?? null);
  handle(IPC.videoExport, async (id: string) => {
    const m = projects.manifest(id);
    const res = await dialog.showSaveDialog(win!, {
      title: "Export video",
      defaultPath: join(app.getPath("videos"), `${projects.dir(id).split(/[\\/]/).pop()}.mp4`),
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
    if (res.canceled || !res.filePath) return null;
    const files: string[] = [];
    const captionParts: { sceneId: string; offset: number; projectId: string }[] = [];
    let offset = 0;
    for (const s of m.scenes) {
      const r = await video.renderFinal(id, s.id);
      if (!r.ok) throw new Error(`Scene "${s.title}" failed to render:\n${r.log}`);
      files.push(join(projects.dir(id), "build", "final", `${s.id}.mp4`));
      captionParts.push({ sceneId: s.id, offset, projectId: id });
      offset += r.durationSec ?? 0;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(runtime.python, ["-m", "studio_manim.concat", res.filePath!, ...files], { env: manimEnv(), windowsHide: true });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || "Could not join the scenes"))));
    });
    // Captions next to the video, for YouTube or an LMS player.
    const srt = voice.buildSrt(captionParts);
    if (srt.trim()) fs.writeFileSync(res.filePath.replace(/\.mp4$/i, "") + ".srt", srt);
    return { path: res.filePath };
  });

  handle(IPC.voiceList, () => voice.VOICES);
  handle(IPC.voiceScript, (id: string, scene: string) => voice.readScript(id, scene));
  handle(IPC.voiceSaveScript, (id: string, scene: string, text: string) => voice.writeScript(id, scene, text));
  handle(IPC.voiceInfo, (id: string, scene: string) => voice.narrationInfo(id, scene));
  handle(IPC.voiceGenerate, async (id: string, scene: string, opts: { voice: string; speed: number }) => {
    const progress = (m: string) => win?.webContents.send(IPC.voiceProgress, m);
    const m = projects.manifest(id);
    projects.saveManifest({ ...m, voice: opts });
    const info = await voice.generateNarration(id, scene, opts, progress);
    await afterNarration(id, scene, progress);
    return info;
  });
  handle(IPC.voiceRecording, async (id: string, scene: string, pcm: Float32Array) => {
    const progress = (m: string) => win?.webContents.send(IPC.voiceProgress, m);
    const info = await voice.narrationFromRecording(id, scene, new Float32Array(pcm), progress);
    await afterNarration(id, scene, progress);
    return info;
  });
  handle(IPC.voiceRemove, async (id: string, scene: string) => {
    voice.removeNarration(id, scene);
    await afterNarration(id, scene, () => {});
  });

  handle(IPC.publishAccount, () => cloud.account());
  handle(IPC.publishSignIn, () => cloud.signIn());
  handle(IPC.publishSignOut, () => cloud.signOut());
  handle(IPC.publishPublish, (req: PublishRequest) => cloud.publish(req));
  handle(IPC.publishVisibility, (id: string, v: Visibility) => cloud.setVisibility(id, v));
  handle(IPC.publishUnpublish, (id: string) => cloud.unpublish(id));
}

app.whenReady().then(async () => {
  ensureLabKit();
  handlePreviewProtocol();
  registerIpc();
  await startToolServer();
  if (process.env.STUDIO_SELFTEST) {
    const { runSelftest } = await import("./selftest");
    await runSelftest(process.env.STUDIO_SELFTEST);
    return;
  }
  createWindow();
  if (app.isPackaged) {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
