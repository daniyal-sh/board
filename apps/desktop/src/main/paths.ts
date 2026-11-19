import { app } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join, resolve } from "node:path";
import { BRAND } from "@studio/shared";

/**
 * Everything is anchored to app.getAppPath() (apps/desktop while developing, app.asar when
 * packaged), not to this module's location: the bundler may move this code into a shared chunk.
 */
const appRoot = () => app.getAppPath();

/** Repository root while developing (apps/desktop -> repo). */
const repoRoot = () => resolve(appRoot(), "../..");

function resource(devPath: string, packagedName: string): string {
  return app.isPackaged ? join(process.resourcesPath, packagedName) : join(repoRoot(), devPath);
}

/** Unpack the bundled lab kit on first launch of this version. */
export function ensureLabKit(): void {
  if (!app.isPackaged) return;
  const dir = paths.labKitDir;
  if (fs.existsSync(join(dir, "src", "index.ts"))) return;
  const target = join(dir, "..");
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xzf", join(process.resourcesPath, "lab-kit.tgz"), "-C", target], { windowsHide: true });
}

export const paths = {
  get projectsDir() {
    return process.env.STUDIO_PROJECTS_DIR || join(app.getPath("documents"), BRAND.projectsFolder);
  },
  /** App-private data: settings, tokens, Python environment, models. */
  get dataDir() {
    return process.env.STUDIO_DATA_DIR || app.getPath("userData");
  },
  /**
   * Lab kit + vendored web libraries used when bundling Labs. Packaged apps ship it as
   * resources/lab-kit.tgz and unpack it once per version (see ensureLabKit).
   */
  get labKitDir() {
    return app.isPackaged ? join(this.dataDir, "lab-kit", app.getVersion(), "lab-kit") : join(repoRoot(), "packages", "lab-kit");
  },
  /** Agent guides (markdown) copied into each project. */
  get guidesDir() {
    return resource("packages/agent-kit/guides", "guides");
  },
  get pythonPluginDir() {
    return resource("python", "python");
  },
  get preload() {
    return join(appRoot(), "out", "preload", "index.cjs");
  },
  get rendererHtml() {
    return join(appRoot(), "out", "renderer", "index.html");
  },
};
