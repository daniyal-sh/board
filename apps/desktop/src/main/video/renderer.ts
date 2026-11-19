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
  plays: { kind: "play" | "wait" | "mark"; label: string; start: number; end: number; line: number | null }[];
  parts: { name: string; type: string; line: number | null; boxes: { t: number; x0: number; y0: number; x1: number; y1: number }[] }[];
}

type Quality = "draft" | "final";
const QUALITY_FLAG: Record<Quality, string> = { draft: "-ql", final: "-qh" };
const QUALITY_DIR: Record<Quality, string> = { draft: "480p15", final: "1080p60" };

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
    ...(fs.existsSync(narration) ? { STUDIO_NARRATION: narration } : {}),
  });
  // Manim's intermediate files have long names (…/partial_movie_files/<Class>/<64-char hash>.mp4).
  // Keep them under a short path so Windows' 260-character limit isn't hit; only the result is copied.
  const media = join(runtime.root, "m", projectId.slice(0, 8));
  const r = await run(
    ["-m", "manim", "render", QUALITY_FLAG[quality], "--media_dir", media, "-o", id, `scenes/${file}`, cls],
    dir,
    env,
  );
  const produced = join(media, "videos", basename(file, ".py"), QUALITY_DIR[quality], `${id}.mp4`);
  if (r.code !== 0 || !fs.existsSync(produced)) {
    return { ok: false, scene: id, seconds: (Date.now() - t0) / 1000, log: cleanLog(r.out) };
  }
  fs.copyFileSync(produced, join(outDir, `${id}.mp4`));
  const tl = timeline(projectId, id, quality);
  if (quality === "draft" && tl) {
    // Thumbnail for the projects list: a frame a little past the middle of the scene.
    const [f] = await frames(projectId, id, [tl.duration * 0.6]);
    if (f) fs.writeFileSync(join(dir, "build", "thumb.png"), f.png);
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

export const video = {
  renderPreview: (projectId: string, sceneId?: string) => render(projectId, sceneId, "draft"),
  renderFinal: (projectId: string, sceneId: string) => render(projectId, sceneId, "final"),
  frames,
  timeline,
};
