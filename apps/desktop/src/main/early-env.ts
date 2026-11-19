// Imported first by index.ts: ES module imports run before any other code, and esbuild reads
// ESBUILD_BINARY_PATH when it is first imported. In a packaged app its binary lives in
// app.asar.unpacked, which esbuild can't find on its own.
import fs from "node:fs";
import { app } from "electron";
import { join } from "node:path";
import { BRAND } from "@studio/shared";

// The app was called "Studio" before it became Board. Its data folder holds the Python and
// LaTeX environment (with absolute paths inside), so an existing one is kept where it is; the
// projects folder is plain files and simply moves to its new name.
app.setName(BRAND.systemName);
if (!process.env.STUDIO_DATA_DIR) {
  const legacyData = join(app.getPath("appData"), BRAND.legacyName);
  // Electron may already have created the new folder (caches), so look for the environment itself.
  if (!fs.existsSync(join(app.getPath("userData"), "runtime")) && fs.existsSync(join(legacyData, "runtime"))) app.setPath("userData", legacyData);
}
if (!process.env.STUDIO_PROJECTS_DIR) {
  const docs = app.getPath("documents");
  const legacy = join(docs, BRAND.legacyName);
  const next = join(docs, BRAND.projectsFolder);
  try {
    const isProjects = (dir: string) => fs.existsSync(dir) && fs.readdirSync(dir).some((d) => fs.existsSync(join(dir, d, "project.json")));
    if (!fs.existsSync(next) && isProjects(legacy)) fs.renameSync(legacy, next);
  } catch {
    /* in use: it stays where it is and the app starts with an empty folder */
  }
}

if (app.isPackaged && !process.env.ESBUILD_BINARY_PATH) {
  const bin = process.platform === "win32" ? "esbuild.exe" : join("bin", "esbuild");
  process.env.ESBUILD_BINARY_PATH = join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@esbuild", `${process.platform}-${process.arch}`, bin);
}
