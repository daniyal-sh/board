import fs from "node:fs";
import { join, normalize, sep } from "node:path";
import { BrowserWindow, protocol } from "electron";
import type { BuildResult } from "@studio/shared";
import { projects } from "../projects";
import { buildSingleFile } from "./bundle";

export const PREVIEW_SCHEME = "studio-preview";

/** Must run before app "ready". */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/** Serves studio-preview://<projectId>/<file> from the project's build folder. */
export function handlePreviewProtocol(): void {
  protocol.handle(PREVIEW_SCHEME, async (req) => {
    const url = new URL(req.url);
    const projectId = url.hostname;
    let buildDir: string;
    try {
      buildDir = join(projects.dir(projectId), "build");
    } catch {
      return new Response("Project not found", { status: 404 });
    }
    const file = normalize(join(buildDir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(buildDir + sep) || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
    const type = file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".mp4") ? "video/mp4" : file.endsWith(".wav") ? "audio/wav" : file.endsWith(".png") ? "image/png" : "application/octet-stream";
    const headers: Record<string, string> = {
      "content-type": type,
      "cache-control": "no-store",
      "content-security-policy": PREVIEW_CSP,
      "accept-ranges": "bytes",
    };
    // <video>/<audio> need byte ranges to seek; without them the player can't jump around.
    const size = fs.statSync(file).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
      const fd = fs.openSync(file, "r");
      const chunk = Buffer.alloc(end - start + 1);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      fs.closeSync(fd);
      return new Response(chunk, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(chunk.length) } });
    }
    return new Response(fs.readFileSync(file), { headers: { ...headers, "content-length": String(size) } });
  });
}

/** Previews run arbitrary agent-written code: no network, no navigation away. */
const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob: studio-preview:; connect-src data: blob:; worker-src blob:";

export function previewUrl(projectId: string, query = ""): string {
  return `${PREVIEW_SCHEME}://${projectId}/preview.html?v=${Date.now()}${query ? `&${query}` : ""}`;
}

/** Build the preview (with bridge) and keep it on disk for the protocol handler. */
export async function buildPreview(projectId: string): Promise<BuildResult> {
  const dir = projects.dir(projectId);
  const m = projects.manifest(projectId);
  const res = await buildSingleFile(dir, m.kind, m.title, true);
  if (!res.ok || !res.html) return { ok: false, errors: res.errors };
  fs.mkdirSync(join(dir, "build"), { recursive: true });
  fs.writeFileSync(join(dir, "build", "preview.html"), res.html);
  return { ok: true, previewUrl: previewUrl(projectId), sizeBytes: res.sizeBytes, libraries: res.libraries, errors: [] };
}

/** Build the shareable single file (no bridge). */
export async function buildExport(projectId: string): Promise<{ html: string; sizeBytes: number; libraries: string[] }> {
  const dir = projects.dir(projectId);
  const m = projects.manifest(projectId);
  const res = await buildSingleFile(dir, m.kind, m.title, false);
  if (!res.ok || !res.html) throw new Error(res.errors.join("\n") || "Build failed");
  return { html: res.html, sizeBytes: res.sizeBytes ?? 0, libraries: res.libraries };
}

export interface ConsoleLine {
  level: "log" | "info" | "warn" | "error";
  text: string;
}

const lastConsole = new Map<string, ConsoleLine[]>();

export function consoleFor(projectId: string): ConsoleLine[] {
  return lastConsole.get(projectId) ?? [];
}

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

const LEVELS: ConsoleLine["level"][] = ["log", "warn", "error", "info"];

/**
 * Load the current preview in a hidden window, collect console output and take screenshots.
 * `times` are seconds after load (useful for animations).
 */
export async function inspectPreview(
  projectId: string,
  opts: { viewport?: ViewportName; times?: number[]; query?: string } = {},
): Promise<{ console: ConsoleLine[]; frames: { time: number; png: Buffer }[] }> {
  // One inspection at a time, in one reused offscreen window (creating and destroying
  // offscreen windows back to back is unreliable).
  const run = queue.then(() => inspectNow(projectId, opts));
  queue = run.catch(() => undefined);
  return run;
}

let queue: Promise<unknown> = Promise.resolve();
let inspector: BrowserWindow | null = null;
let sink: ConsoleLine[] | null = null;

function inspectorWindow(): BrowserWindow {
  if (inspector && !inspector.isDestroyed()) return inspector;
  inspector = new BrowserWindow({
    show: false,
    width: VIEWPORTS.desktop.width,
    height: VIEWPORTS.desktop.height,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  inspector.webContents.on("console-message", (e) => {
    const ev = e as unknown as { level: string | number; message: string };
    const raw = typeof ev.level === "number" ? LEVELS[ev.level] ?? "log" : String(ev.level);
    if (/Electron Security Warning/.test(ev.message)) return;
    sink?.push({ level: (raw === "warning" ? "warn" : raw) as ConsoleLine["level"], text: ev.message });
  });
  inspector.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  inspector.webContents.on("will-navigate", (e) => e.preventDefault());
  return inspector;
}

async function inspectNow(
  projectId: string,
  opts: { viewport?: ViewportName; times?: number[]; query?: string },
): Promise<{ console: ConsoleLine[]; frames: { time: number; png: Buffer }[] }> {
  const vp = VIEWPORTS[opts.viewport ?? "desktop"];
  const times = (opts.times?.length ? opts.times : [1.5]).slice().sort((a, b) => a - b);
  const win = inspectorWindow();
  win.setContentSize(vp.width, vp.height);
  const lines: ConsoleLine[] = [];
  sink = lines;
  const frames: { time: number; png: Buffer }[] = [];
  try {
    await win.loadURL(previewUrl(projectId, opts.query)).catch(async (e: Error) => {
      // A load can be aborted by a late navigation from the previous page; retry once.
      if (!/ERR_(FAILED|ABORTED)/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 300));
      await win.loadURL(previewUrl(projectId, opts.query));
    });
    let elapsed = 0;
    for (const t of times) {
      await new Promise((r) => setTimeout(r, Math.max(0, (t - elapsed) * 1000)));
      elapsed = t;
      const img = await win.webContents.capturePage();
      frames.push({ time: t, png: img.toPNG() });
      if (vp === VIEWPORTS.desktop && frames.length === 1 && !img.isEmpty()) {
        // Thumbnail for the projects list.
        fs.writeFileSync(join(projects.dir(projectId), "build", "thumb.png"), img.resize({ width: 480 }).toPNG());
      }
    }
  } finally {
    sink = null;
    void win.loadURL("about:blank").catch(() => {});
  }
  // The bridge echoes console calls through postMessage too; drop exact duplicates.
  const unique = lines.filter((l, i) => lines.findIndex((o) => o.text === l.text && o.level === l.level) === i);
  lastConsole.set(projectId, unique);
  return { console: unique, frames };
}

/**
 * Web animations: a picture of each scene, taken from the middle of it in the recorded player.
 * Saved as build/thumbs/<scene>.png for the storyboard and the timeline filmstrip.
 */
export function webSceneThumbnails(projectId: string): Promise<number> {
  const run = queue.then(async () => {
    const win = inspectorWindow();
    win.setContentSize(VIEWPORTS.desktop.width, Math.round((VIEWPORTS.desktop.width * 9) / 16));
    await win.loadURL(previewUrl(projectId, "still=1")).catch(() => {});
    let scenes: { id: string; start: number; end: number }[] = [];
    for (let i = 0; i < 60 && !scenes.length; i++) {
      await new Promise((r) => setTimeout(r, 250));
      scenes = (await win.webContents.executeJavaScript("window.__studioPlayer?.ready ? window.__studioPlayer.scenes : []").catch(() => [])) as typeof scenes;
    }
    const out = join(projects.dir(projectId), "build", "thumbs");
    fs.mkdirSync(out, { recursive: true });
    for (const s of scenes) {
      await win.webContents.executeJavaScript(`window.__studioPlayer.seek(${s.start + (s.end - s.start) * 0.6})`).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const img = await win.webContents.capturePage();
      if (!img.isEmpty()) fs.writeFileSync(join(out, `${s.id}.png`), img.resize({ width: 480 }).toPNG());
    }
    void win.loadURL("about:blank").catch(() => {});
    return scenes.length;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Close the inspector (call before quitting). */
export function closeInspector(): void {
  if (inspector && !inspector.isDestroyed()) inspector.destroy();
  inspector = null;
}
