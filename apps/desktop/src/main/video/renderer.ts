import { spawn } from "node:child_process";
import fs from "node:fs";
import { basename, join } from "node:path";
import { projects } from "../projects";
import { manimEnv, runtime, videoEnvStatus } from "./env";

export interface RenderResult {
  ok: boolean;
  scene: string;
  seconds: number;
  durationSec?: number;
  log: string;
}

export interface SceneTimeline {
  scene: string;
  duration: number;
  marks: Record<string, number>;
  plays: { kind: "play" | "wait" | "mark" | "stop"; label: string; start: number; end: number; line: number | null; loop?: boolean }[];
  parts: { name: string; type: string; line: number | null; boxes: { t: number; x0: number; y0: number; x1: number; y1: number; o?: number }[] }[];
}

type Quality = "draft" | "final";
const QUALITY_FLAG: Record<Quality, string> = { draft: "-ql", final: "-qh" };
const QUALITY_DIR: Record<Quality, string> = { draft: "480p15", final: "1080p60" };
/** Vertical (9:16) videos: same quality presets, portrait resolution. Manim names the folder <height>p<fps>. */
const VERTICAL: Record<Quality, { res: string; dir: string }> = { draft: { res: "480,854", dir: "854p15" }, final: { res: "1080,1920", dir: "1920p60" } };

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(runtime.python, args, { cwd, env, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out = (out + d).slice(-60000)));
    child.stderr.on("data", (d) => (out = (out + d).slice(-60000)));
    child.on("error", (e) => resolve({ code: -1, out: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

/** Keep what helps the agent fix a failure: the traceback, without progress bars. */
function cleanLog(out: string): string {
  const lines = out
    .replace(/\x1b\[[0-9;]*m/g, "")
    // Rich tracebacks draw boxes; keep the text.
    .replace(/[│┌┐└┘─╭╮╰╯]+/g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() && !/^\s*(Animation \d+|%|\d+%\|)/.test(l) && !/it\/s\]/.test(l) && !/site-packages/.test(l));
  // The error message is the last line that names an exception; show the scene lines above it.
  const errIdx = lines.map((l, i) => (/^\s*\w+(Error|Exception)\b|^\s*\w+Error:/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
  const sceneFrames = lines.filter((l) => /scenes[\\/]\d*_?\w+\.py:\d+/.test(l) || /^\s*>\s*\d+/.test(l));
  if (errIdx !== undefined) return [...sceneFrames.slice(-6), ...lines.slice(errIdx, errIdx + 6)].join("\n");
  return lines.slice(-15).join("\n");
}

function sceneFiles(dir: string): string[] {
  const sd = join(dir, "scenes");
  return fs.existsSync(sd) ? fs.readdirSync(sd).filter((f) => f.endsWith(".py") && !f.startsWith("_")).sort() : [];
}

/** The requested scene, or the most recently edited one. */
function pickScene(dir: string, sceneId?: string): string | undefined {
  const files = sceneFiles(dir);
  if (sceneId) return files.find((f) => basename(f, ".py") === sceneId);
  return files
    .map((f) => ({ f, t: fs.statSync(join(dir, "scenes", f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0]?.f;
}

function className(source: string): string | undefined {
  return /^class\s+(\w+)\s*\([^)]*Scene[^)]*\)\s*:/m.exec(source)?.[1];
}

async function render(projectId: string, sceneId: string | undefined, quality: Quality): Promise<RenderResult> {
  const t0 = Date.now();
  const dir = projects.dir(projectId);
  if (!videoEnvStatus().ready) {
    return { ok: false, scene: sceneId ?? "", seconds: 0, log: "Video tools are not installed yet. Ask the teacher to finish video setup (Settings → Rendering)." };
  }
  const file = pickScene(dir, sceneId);
  if (!file) return { ok: false, scene: sceneId ?? "", seconds: 0, log: "No scene files found in scenes/." };
  const id = basename(file, ".py");
  const cls = className(fs.readFileSync(join(dir, "scenes", file), "utf8"));
  if (!cls) return { ok: false, scene: id, seconds: 0, log: `scenes/${file} has no Scene class.` };

  const outDir = join(dir, "build", quality === "draft" ? "scenes" : "final");
  fs.mkdirSync(outDir, { recursive: true });
  const narration = join(dir, "build", "narration", `${id}.json`);
  const env = manimEnv({
    STUDIO_TIMELINE_OUT: join(outDir, `${id}.timeline.json`),
    ...(projects.manifest(projectId).aspect === "vertical" ? { STUDIO_ASPECT: "vertical" } : {}),
    ...(fs.existsSync(narration) ? { STUDIO_NARRATION: narration } : {}),
  });
  // Manim's intermediate files have long names (…/partial_movie_files/<Class>/<64-char hash>.mp4).
  // Keep them under a short path so Windows' 260-character limit isn't hit; only the result is copied.
  const media = join(runtime.root, "m", projectId.slice(0, 8));
  const vertical = projects.manifest(projectId).aspect === "vertical";
  const r = await run(
    ["-m", "manim", "render", QUALITY_FLAG[quality], ...(vertical ? ["-r", VERTICAL[quality].res] : []), "--media_dir", media, "-o", id, `scenes/${file}`, cls],
    dir,
    env,
  );
  const produced = join(media, "videos", basename(file, ".py"), vertical ? VERTICAL[quality].dir : QUALITY_DIR[quality], `${id}.mp4`);
  if (r.code !== 0 || !fs.existsSync(produced)) {
    return { ok: false, scene: id, seconds: (Date.now() - t0) / 1000, log: cleanLog(r.out) };
  }
  fs.copyFileSync(produced, join(outDir, `${id}.mp4`));
  const tl = timeline(projectId, id, quality);
  if (quality === "draft" && tl) {
    // Thumbnail for the projects list: a frame a little past the middle of the scene.
    const [f] = await frames(projectId, id, [tl.duration * 0.6]);
    if (f) {
      fs.writeFileSync(join(dir, "build", "thumb.png"), f.png);
      fs.mkdirSync(join(dir, "build", "thumbs"), { recursive: true });
      fs.writeFileSync(join(dir, "build", "thumbs", `${id}.png`), f.png);
    }
  }
  return { ok: true, scene: id, seconds: (Date.now() - t0) / 1000, durationSec: tl?.duration, log: warningsOnly(r.out) };
}

function warningsOnly(out: string): string {
  const w = out
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .filter((l) => /WARNING/.test(l))
    .slice(-8);
  return w.length ? `Warnings:\n${w.join("\n")}` : "";
}

export function timeline(projectId: string, sceneId: string, quality: Quality = "draft"): SceneTimeline | undefined {
  const file = join(projects.dir(projectId), "build", quality === "draft" ? "scenes" : "final", `${sceneId}.timeline.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SceneTimeline;
  } catch {
    return undefined;
  }
}

async function frames(projectId: string, sceneId: string | undefined, times: number[]): Promise<{ scene: string; time: number; png: Buffer }[]> {
  const dir = projects.dir(projectId);
  const file = pickScene(dir, sceneId);
  if (!file) return [];
  const id = basename(file, ".py");
  const video = join(dir, "build", "scenes", `${id}.mp4`);
  if (!fs.existsSync(video)) return [];
  const out = join(dir, "build", "frames", id);
  fs.rmSync(out, { recursive: true, force: true });
  const r = await run(["-m", "studio_manim.frames", video, out, ...times.map(String)], dir, manimEnv());
  try {
    const list = JSON.parse(r.out.trim().split(/\r?\n/).pop() ?? "[]") as { time: number; path: string }[];
    return list.map((f) => ({ scene: id, time: f.time, png: fs.readFileSync(f.path) }));
  } catch {
    return [];
  }
}

/** A render is out of date when its scene file or narration changed after it was made. */
function draftIsStale(dir: string, id: string, quality: Quality = "draft"): boolean {
  const mp4 = join(dir, "build", quality === "draft" ? "scenes" : "final", `${id}.mp4`);
  if (!fs.existsSync(mp4)) return true;
  const rendered = fs.statSync(mp4).mtimeMs;
  const inputs = [join(dir, "scenes", `${id}.py`), join(dir, "build", "narration", `${id}.json`)];
  return inputs.some((f) => fs.existsSync(f) && fs.statSync(f).mtimeMs > rendered);
}

export interface FullPreview {
  ok: boolean;
  /** studio-preview URL of the joined draft. */
  url?: string;
  duration: number;
  /** Where each scene sits in the joined video. */
  segments: { sceneId: string; title: string; start: number; end: number }[];
  /** Scenes that failed to render (they're left out of the preview). */
  failed: { sceneId: string; title: string; log: string }[];
}

function concat(out: string, inputs: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.python, ["-m", "studio_manim.concat", out, ...inputs], { cwd, env: manimEnv(), windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(cleanLog(err) || "Could not join the scenes"))));
  });
}

/**
 * The whole video as one draft: render scenes that are missing or out of date, then join the
 * drafts (no re-encoding). Reused as long as no scene changed.
 */
async function fullPreview(projectId: string, progress: (message: string) => void): Promise<FullPreview> {
  const dir = projects.dir(projectId);
  // Slides: only the animated slides are Manim scenes.
  const scenes = projects.manifest(projectId).scenes.filter((s) => s.file.endsWith(".py"));
  const failed: FullPreview["failed"] = [];
  if (!videoEnvStatus().ready) return { ok: false, duration: 0, segments: [], failed: [{ sceneId: "", title: "", log: "Video tools are not installed yet." }] };

  const stale = scenes.filter((s) => draftIsStale(dir, s.id));
  for (const [i, s] of stale.entries()) {
    progress(`Rendering “${s.title}” (${i + 1} of ${stale.length})…`);
    const r = await render(projectId, s.id, "draft");
    if (!r.ok) failed.push({ sceneId: s.id, title: s.title, log: r.log });
  }

  const parts = scenes
    .map((s) => ({ s, file: join(dir, "build", "scenes", `${s.id}.mp4`), tl: timeline(projectId, s.id) }))
    .filter((p) => fs.existsSync(p.file) && !failed.some((f) => f.sceneId === p.s.id));
  if (!parts.length) return { ok: false, duration: 0, segments: [], failed };

  const segments: FullPreview["segments"] = [];
  let t = 0;
  for (const p of parts) {
    const d = p.tl?.duration ?? 0;
    segments.push({ sceneId: p.s.id, title: p.s.title, start: t, end: t + d });
    t += d;
  }

  const out = join(dir, "build", "full.mp4");
  const manifestFile = join(dir, "build", "full.json");
  const key = JSON.stringify(parts.map((p) => [p.s.id, fs.statSync(p.file).mtimeMs]));
  const cachedKey = fs.existsSync(manifestFile) ? (JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { key: string }).key : "";
  if (!fs.existsSync(out) || cachedKey !== key) {
    progress("Joining the scenes…");
    await concat(out, parts.map((p) => p.file), dir);
    fs.writeFileSync(manifestFile, JSON.stringify({ key }));
  }
  const url = `studio-preview://${projectId}/full.mp4?v=${Math.round(fs.statSync(out).mtimeMs)}`;
  return { ok: true, url, duration: t, segments, failed };
}

/** Render the drafts of scenes that are missing or out of date (Slides: the animated slides). */
async function renderStale(projectId: string, progress: (message: string) => void): Promise<{ sceneId: string; title: string; log: string }[]> {
  const dir = projects.dir(projectId);
  if (!videoEnvStatus().ready) return [];
  const stale = projects.manifest(projectId).scenes.filter((s) => s.file.endsWith(".py") && draftIsStale(dir, s.id));
  const failed: { sceneId: string; title: string; log: string }[] = [];
  for (const [i, s] of stale.entries()) {
    progress(`Rendering “${s.title}” (${i + 1} of ${stale.length})…`);
    const r = await render(projectId, s.id, "draft");
    if (!r.ok) failed.push({ sceneId: s.id, title: s.title, log: r.log });
  }
  return failed;
}

export const video = {
  renderStale,
  /** The high-quality render of a scene is missing or older than its source. */
  finalIsStale: (projectId: string, sceneId: string) => draftIsStale(projects.dir(projectId), sceneId, "final"),
  renderPreview: (projectId: string, sceneId?: string) => render(projectId, sceneId, "draft"),
  renderFinal: (projectId: string, sceneId: string) => render(projectId, sceneId, "final"),
  fullPreview,
  frames,
  timeline,
};
