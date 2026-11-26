import { spawn } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { projects } from "../projects";
import * as voice from "../voice";
import { manimEnv, runtime } from "./env";
import { video } from "./renderer";

/** Render every scene in high quality and join them into one MP4 (plus captions next to it). */
export async function exportFinalVideo(id: string, outPath: string, captions: boolean): Promise<void> {
  const m = projects.manifest(id);
  const files: string[] = [];
  const captionParts: { sceneId: string; offset: number; projectId: string }[] = [];
  let offset = 0;
  for (const s of m.scenes.filter((x) => x.file.endsWith(".py"))) {
    const r = await video.renderFinal(id, s.id);
    if (!r.ok) throw new Error(`Scene "${s.title}" failed to render:\n${r.log}`);
    files.push(join(projects.dir(id), "build", "final", `${s.id}.mp4`));
    captionParts.push({ sceneId: s.id, offset, projectId: id });
    offset += r.durationSec ?? 0;
  }
  await runPython(["-m", "studio_manim.concat", outPath, ...files], "Could not join the scenes");
  if (!captions) return;
  // Captions next to the video, for YouTube or an LMS player.
  const srt = voice.buildSrt(captionParts);
  if (srt.trim()) fs.writeFileSync(outPath.replace(/\.mp4$/i, "") + ".srt", srt);
}

export function runPython(args: string[], failure: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(runtime.python, args, { env: manimEnv(), windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split(/\r?\n/).slice(-3).join("\n") || failure))));
  });
}

/** A looping GIF of the whole video, scaled to `width`. */
export async function exportVideoGif(id: string, outPath: string, width: number, fps = 15): Promise<void> {
  const mp4 = join(projects.dir(id), "build", "export.mp4");
  await exportFinalVideo(id, mp4, false);
  await runPython(["-m", "studio_manim.gif", mp4, outPath, String(width), String(fps)], "Could not make the GIF");
}
