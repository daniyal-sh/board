import fs from "node:fs";
import { join, normalize, sep } from "node:path";
import { BrowserWindow, protocol } from "electron";
import type { BuildResult } from "@studio/shared";
import { projects } from "../projects";
import { buildSingleFile } from "./bundle";
import { spread } from "../inspect/sheet";

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
  const res = await buildSingleFile(dir, m.kind, m.title, true, m.aspect);
  if (!res.ok || !res.html) return { ok: false, errors: res.errors };
  fs.mkdirSync(join(dir, "build"), { recursive: true });
  fs.writeFileSync(join(dir, "build", "preview.html"), res.html);
  return { ok: true, previewUrl: previewUrl(projectId), sizeBytes: res.sizeBytes, libraries: res.libraries, errors: [] };
}

/** Build the shareable single file (no bridge). */
export async function buildExport(projectId: string): Promise<{ html: string; sizeBytes: number; libraries: string[] }> {
  const dir = projects.dir(projectId);
  const m = projects.manifest(projectId);
  const res = await buildSingleFile(dir, m.kind, m.title, false, m.aspect);
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
    if (projects.manifest(projectId).aspect === "vertical") win.setContentSize(450, 800);
    else win.setContentSize(VIEWPORTS.desktop.width, Math.round((VIEWPORTS.desktop.width * 9) / 16));
    await win.loadURL(previewUrl(projectId, "still=1")).catch(() => {});
    let scenes: { id: string; start: number; end: number }[] = [];
    for (let i = 0; i < 60 && !scenes.length; i++) {
      await new Promise((r) => setTimeout(r, 250));
      scenes = (await win.webContents.executeJavaScript("window.__studioPlayer?.ready ? window.__studioPlayer.scenes : []").catch(() => [])) as typeof scenes;
    }
    const out = join(projects.dir(projectId), "build", "thumbs");
    fs.mkdirSync(out, { recursive: true });
    // Pictures of the animation, without the narration captions over them.
    await win.webContents.executeJavaScript(`window.postMessage({ __studio: 1, type: "player", cmd: "captions", value: false }, "*")`).catch(() => {});
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

/**
 * Web animations as a GIF: step through the recorded timeline in the hidden window, capture each
 * frame and encode them with one shared palette (so flat colours don't flicker).
 */
export function webGif(projectId: string, outPath: string, size: { width: number; height: number; fps: number }): Promise<void> {
  const run = queue.then(async () => {
    // gifenc is CommonJS: its functions may arrive on `default`.
    const mod = await import("gifenc");
    const { GIFEncoder, applyPalette, quantize } = typeof mod.quantize === "function" ? mod : (mod as unknown as { default: typeof mod }).default;
    const win = inspectorWindow();
    win.setContentSize(size.width, size.height);
    try {
      await win.loadURL(previewUrl(projectId, "still=1")).catch(() => {});
      let duration = 0;
      for (let i = 0; i < 80 && !duration; i++) {
        await new Promise((r) => setTimeout(r, 250));
        duration = Number(await win.webContents.executeJavaScript("window.__studioPlayer?.ready ? window.__studioPlayer.duration() : 0").catch(() => 0));
      }
      if (!duration) throw new Error("The animation didn't load. Check the preview for errors.");
      // Long animations make huge GIFs; keep the first two minutes.
      const count = Math.max(1, Math.ceil(Math.min(duration, 120) * size.fps));
      const frames: Uint8Array[] = [];
      for (let f = 0; f < count; f++) {
        await win.webContents.executeJavaScript(`window.__studioPlayer.seek(${(f / size.fps).toFixed(4)})`);
        await win.webContents.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        const img = (await win.webContents.capturePage()).resize({ width: size.width, height: size.height });
        const bgra = img.toBitmap();
        const rgba = new Uint8Array(bgra.length);
        for (let p = 0; p < bgra.length; p += 4) {
          rgba[p] = bgra[p + 2];
          rgba[p + 1] = bgra[p + 1];
          rgba[p + 2] = bgra[p];
          rgba[p + 3] = 255;
        }
        frames.push(rgba);
      }
      // Shared palette from a spread of frames.
      const pick = frames.filter((_, k) => k % Math.max(1, Math.floor(frames.length / 12)) === 0).slice(0, 12);
      const sheet = new Uint8Array(pick.reduce((n, fr) => n + fr.length, 0));
      let o = 0;
      for (const fr of pick) {
        sheet.set(fr, o);
        o += fr.length;
      }
      const palette = quantize(sheet, 256);
      const gif = GIFEncoder();
      const delay = Math.round(1000 / size.fps);
      for (const fr of frames) gif.writeFrame(applyPalette(fr, palette), size.width, size.height, { palette, delay });
      gif.finish();
      fs.writeFileSync(outPath, gif.bytes());
    } finally {
      void win.loadURL("about:blank").catch(() => {});
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------- web animations: steps

export interface WebStepFrame {
  t: number;
  scene: string;
  label: string;
  png: Buffer;
  layout: { name: string; type: string; box: { x0: number; y0: number; x1: number; y1: number } }[];
}

/**
 * Load the recorded web animation in the hidden window and, at the end of each animation step,
 * take a picture and measure what's on screen. `scene` limits it to one scene.
 */
export function webSteps(projectId: string, opts: { scene?: string; max?: number; pictures?: boolean } = {}): Promise<{ frames: WebStepFrame[]; console: ConsoleLine[]; duration: number }> {
  const run = queue.then(async () => {
    const vertical = projects.manifest(projectId).aspect === "vertical";
    const win = inspectorWindow();
    win.setContentSize(vertical ? 450 : 960, vertical ? 800 : 540);
    const lines: ConsoleLine[] = [];
    sink = lines;
    try {
      const q = ["still=1", opts.scene ? `scene=${encodeURIComponent(opts.scene)}&only=1` : ""].filter(Boolean).join("&");
      await win.loadURL(previewUrl(projectId, q)).catch(() => {});
      let ready = false;
      for (let i = 0; i < 80 && !ready; i++) {
        await new Promise((r) => setTimeout(r, 200));
        ready = Boolean(await win.webContents.executeJavaScript("Boolean(window.__studioPlayer?.ready)").catch(() => false));
      }
      if (!ready) return { frames: [], console: lines, duration: 0 };
      const steps = (await win.webContents.executeJavaScript("window.__studioPlayer.steps")) as { start: number; end: number; scene: string; label: string }[];
      const duration = Number(await win.webContents.executeJavaScript("window.__studioPlayer.duration()"));
      const frames: WebStepFrame[] = [];
      for (const s of spread(steps, opts.max ?? 12)) {
        const t = Math.max(s.start + 0.01, s.end - 0.02);
        await win.webContents.executeJavaScript(`window.__studioPlayer.seek(${t.toFixed(3)})`);
        await win.webContents.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        const layout = (await win.webContents.executeJavaScript("window.__studioPlayer.layout()").catch(() => [])) as WebStepFrame["layout"];
        const png = opts.pictures === false ? Buffer.alloc(0) : (await win.webContents.capturePage()).toPNG();
        frames.push({ t, scene: s.scene, label: s.label, png, layout });
      }
      return { frames, console: lines, duration };
    } finally {
      sink = null;
      void win.loadURL("about:blank").catch(() => {});
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------- Labs: checks and interaction

export type LabAction =
  | { click: string }
  | { set: string; value: string | number | boolean }
  | { type: string; text: string }
  | { press: string; target?: string }
  | { wait: number };

export interface LabSession {
  png: Buffer;
  console: ConsoleLine[];
  findings: string[];
  controls: string[];
  results: string[];
}

/** Runs inside the page: layout problems a teacher would notice, and the controls students can use. */
const LAB_PROBE = String.raw`(() => {
  const W = innerWidth, out = [], seen = new Set();
  const name = (el) => {
    const part = el.closest("[data-part]")?.getAttribute("data-part");
    const id = el.id ? "#" + el.id : "";
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return (part ? "[" + part + "] " : "") + el.tagName.toLowerCase() + id + (text ? " “" + text + "”" : "");
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05; };
  const doc = document.documentElement;
  if (doc.scrollWidth > W + 2) {
    out.push("The page scrolls sideways: it is " + (doc.scrollWidth - W) + " px wider than the screen.");
    const wide = [...document.body.querySelectorAll("*")].filter((el) => visible(el) && el.getBoundingClientRect().right > W + 2 && !el.closest("svg, canvas"));
    const top = wide.filter((el) => !wide.includes(el.parentElement)).slice(0, 3);
    for (const el of top) out.push("  Too wide: " + name(el) + " (" + Math.round(el.getBoundingClientRect().width) + " px)");
  }
  for (const el of document.body.querySelectorAll("*")) {
    if (!visible(el) || el.closest("svg")) continue;
    const s = getComputedStyle(el);
    const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (direct && parseFloat(s.fontSize) < 12 && !seen.has("small")) { seen.add("small"); out.push("Small text (" + s.fontSize + "): " + name(el)); }
    if (direct && (s.overflow.includes("hidden") || s.textOverflow === "ellipsis") && el.scrollWidth > el.clientWidth + 2 && out.length < 12) out.push("Text is cut off: " + name(el));
    if (el.tagName === "IMG" && el.complete && !el.naturalWidth) out.push("Image did not load: " + name(el));
  }
  const controls = [...document.querySelectorAll("input, select, textarea, button, [role=slider], [role=button], a[href], [data-part][tabindex]")].filter(visible);
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (W < 500 && (r.height < 24 || r.width < 24) && el.type !== "range" && out.length < 14) out.push("Small tap target (" + Math.round(r.width) + "×" + Math.round(r.height) + " px): " + name(el));
    if (r.left < -1 || r.right > W + 1) out.push("Control is partly off screen: " + name(el));
  }
  const desc = controls.slice(0, 30).map((el) => {
    const label = el.labels?.[0]?.textContent?.trim();
    const t = el.tagName.toLowerCase() + (el.type ? "[" + el.type + "]" : "");
    const extra = el.type === "range" || el.type === "number" ? " value=" + el.value + " (" + (el.min || "?") + "–" + (el.max || "?") + ")" : el.type === "checkbox" ? " checked=" + el.checked : el.tagName === "SELECT" ? " value=" + el.value : "";
    return name(el) + " · " + t + (label ? " label “" + label + "”" : "") + extra;
  });
  return { findings: [...new Set(out)], controls: desc };
})()`;

/** Find a control by data-part, CSS selector, label or visible text, then act on it. */
const LAB_ACT = String.raw`(async (a) => {
  const find = (q) => {
    if (!q) return document.activeElement;
    let el = document.querySelector('[data-part="' + CSS.escape(q) + '"]');
    if (el) {
      const inner = el.matches("input, select, textarea, button") ? el : el.querySelector("input, select, textarea, button");
      return inner || el;
    }
    try { el = document.querySelector(q); if (el) return el; } catch {}
    const lower = q.toLowerCase();
    for (const l of document.querySelectorAll("label")) if (l.textContent.trim().toLowerCase().includes(lower)) return l.control || l;
    for (const b of document.querySelectorAll("button, a, [role=button], summary")) if (b.textContent.trim().toLowerCase().includes(lower)) return b;
    for (const i of document.querySelectorAll("[aria-label], [title], [placeholder]")) if ((i.getAttribute("aria-label") || i.title || i.placeholder || "").toLowerCase().includes(lower)) return i;
    return null;
  };
  if ("wait" in a) { await new Promise((r) => setTimeout(r, Math.min(5000, a.wait))); return "waited " + a.wait + " ms"; }
  const q = a.click ?? a.set ?? a.type ?? a.target;
  const target = find(q);
  if (!target) return "not found: " + q;
  target.scrollIntoView({ block: "center" });
  if ("click" in a) {
    const r = target.getBoundingClientRect();
    const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    target.dispatchEvent(new PointerEvent("pointerdown", o)); target.dispatchEvent(new MouseEvent("mousedown", o));
    target.dispatchEvent(new PointerEvent("pointerup", o)); target.dispatchEvent(new MouseEvent("mouseup", o));
    target.click();
    return "clicked " + (target.textContent || target.tagName).trim().slice(0, 40);
  }
  if ("set" in a) {
    if (target.type === "checkbox" || target.type === "radio") target.checked = Boolean(a.value);
    else {
      const proto = target.tagName === "SELECT" ? HTMLSelectElement.prototype : target.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(target, String(a.value));
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return "set to " + (target.type === "checkbox" ? target.checked : target.value);
  }
  if ("type" in a) {
    target.focus();
    const setter = Object.getOwnPropertyDescriptor(target.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
    setter.call(target, (target.value || "") + a.text);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    return "typed “" + a.text + "”";
  }
  if ("press" in a) {
    target.focus?.();
    for (const t of ["keydown", "keypress", "keyup"]) target.dispatchEvent(new KeyboardEvent(t, { key: a.press, bubbles: true }));
    if (a.press === "Enter" && target.form) target.form.requestSubmit?.();
    return "pressed " + a.press;
  }
  return "unknown action";
})`;

/** Open the Lab fresh in the hidden window, run actions, then check the layout and take a picture. */
export function labSession(projectId: string, opts: { viewport?: ViewportName; actions?: LabAction[] } = {}): Promise<LabSession> {
  const run = queue.then(async () => {
    const vp = VIEWPORTS[opts.viewport ?? "desktop"];
    const win = inspectorWindow();
    win.setContentSize(vp.width, vp.height);
    const lines: ConsoleLine[] = [];
    sink = lines;
    try {
      await win.loadURL(previewUrl(projectId)).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      const results: string[] = [];
      for (const a of opts.actions ?? []) {
        const r = await win.webContents.executeJavaScript(`${LAB_ACT}(${JSON.stringify(a)})`).catch((e: Error) => `failed: ${e.message}`);
        results.push(String(r));
        await new Promise((res) => setTimeout(res, 250));
      }
      await new Promise((r) => setTimeout(r, 300));
      const probe = (await win.webContents.executeJavaScript(LAB_PROBE).catch(() => ({ findings: [], controls: [] }))) as { findings: string[]; controls: string[] };
      const png = (await win.webContents.capturePage()).toPNG();
      return { png, console: lines.filter((l, i) => lines.findIndex((o) => o.text === l.text) === i), findings: probe.findings, controls: probe.controls, results };
    } finally {
      sink = null;
      void win.loadURL("about:blank").catch(() => {});
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Close the inspector (call before quitting). */
export function closeInspector(): void {
  if (inspector && !inspector.isDestroyed()) inspector.destroy();
  inspector = null;
}
