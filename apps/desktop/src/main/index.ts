import "./early-env";
import fs from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from "electron";
import { BRAND, DEFAULT_ACCESS, IPC, type AgentEvent, type AgentProviderId, type AgentSettings, type ApprovalDecision, type CreateProjectInput, type Selection } from "@studio/shared";
import { providerStatus } from "./agents/detect";
import { agentDefaults, providerModels, setAgentDefaults } from "./agents/models";
import { interruptAgent, sendToAgent, stopAllAgents } from "./agents/manager";
import { disposeAllCodex } from "./agents/codex";
import { answerQuestions, resetAlways, respond as respondApproval } from "./agents/approvals";
import { setSelection, startToolServer } from "./agents/tools";
import { buildExport, buildPreview, handlePreviewProtocol, webGif, webSceneThumbnails, registerPreviewScheme, PREVIEW_SCHEME } from "./build/preview";
import { listHistory, restoreTo, undoLast } from "./history";
import { ensureLabKit, paths } from "./paths";
import { projects } from "./projects";
import { setMainWindow } from "./window";
import { exportFinalVideo, exportVideoGif } from "./video/export";
import { setupVideoEnv, videoEnvStatus, manimEnv, runtime } from "./video/env";
import { video } from "./video/renderer";
import * as voice from "./voice";
import { autoNarrate, retimeScene } from "./narrate";

registerPreviewScheme();
// Windows groups taskbar windows (and picks their icon) by this id.
if (process.platform === "win32") app.setAppUserModelId(BRAND.appId);

let win: BrowserWindow | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#151517" : "#F3F3F5",
    // Packaged builds take the icon from the executable; this covers development and Linux.
    icon: join(app.getAppPath(), "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
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
  setMainWindow(win);
  win.on("closed", () => setMainWindow(null));
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
function afterNarration(id: string, scene: string, progress: (m: string) => void): Promise<void> {
  return retimeScene(id, scene, progress, emit);
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
    if ((m.agent.access ?? DEFAULT_ACCESS) !== (settings.access ?? DEFAULT_ACCESS)) resetAlways(id);
    // A thread belongs to one provider; switching providers starts a fresh conversation there.
    projects.saveManifest({ ...m, agent: settings });
  });
  handle(IPC.agentAnswer, (_id: string, requestId: string, answers: string[] | null) => answerQuestions(requestId, answers, emit));
  handle(IPC.agentApproval, (_id: string, requestId: string, decision: ApprovalDecision) => respondApproval(requestId, decision, emit));
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
    const r = await undoLast(projects.dir(id));
    emit({ type: "preview.updated", projectId: id });
    return r;
  });
  handle(IPC.voiceAuto, (id: string, opts: { voice: string; speed: number; scriptsReady?: boolean }) =>
    autoNarrate(id, opts, emit, (m) => win?.webContents.send(IPC.voiceProgress, m)),
  );

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

  handle(IPC.buildThumbs, async (id: string) => {
    if (projects.manifest(id).kind === "web") await webSceneThumbnails(id);
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
  handle(IPC.videoFull, (id: string) => video.fullPreview(id, (m) => win?.webContents.send(IPC.videoProgress, m)));
  handle(IPC.videoExport, async (id: string) => {
    const res = await dialog.showSaveDialog(win!, {
      title: "Export video",
      defaultPath: join(app.getPath("videos"), `${projects.dir(id).split(/[\\/]/).pop()}.mp4`),
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
    if (res.canceled || !res.filePath) return null;
    await exportFinalVideo(id, res.filePath, true);
    return { path: res.filePath };
  });

  handle(IPC.exportGif, async (id: string) => {
    const m = projects.manifest(id);
    const vertical = m.aspect === "vertical";
    const res = await dialog.showSaveDialog(win!, {
      title: "Export GIF",
      defaultPath: join(app.getPath(m.kind === "video" ? "videos" : "downloads"), `${projects.dir(id).split(/[\\/]/).pop()}.gif`),
      filters: [{ name: "GIF animation", extensions: ["gif"] }],
    });
    if (res.canceled || !res.filePath) return null;
    // Small enough to drop into slides, an LMS page or a chat.
    const width = vertical ? 360 : 640;
    if (m.kind === "video") {
      await exportVideoGif(id, res.filePath, width);
    } else if (m.kind === "web") {
      await buildPreview(id);
      await webGif(id, res.filePath, { width, height: Math.round(vertical ? width * 16 / 9 : width * 9 / 16), fps: 15 });
    } else throw new Error("Labs are interactive pages; export them as HTML instead.");
    return { path: res.filePath, sizeBytes: fs.statSync(res.filePath).size };
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
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Don't leave agent CLIs or Codex app-servers running after the app closes.
app.on("before-quit", () => {
  stopAllAgents();
  disposeAllCodex();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
