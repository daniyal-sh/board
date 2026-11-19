// Imported first by index.ts: ES module imports run before any other code, and esbuild reads
// ESBUILD_BINARY_PATH when it is first imported. In a packaged app its binary lives in
// app.asar.unpacked, which esbuild can't find on its own.
import { app } from "electron";
import { join } from "node:path";

if (app.isPackaged && !process.env.ESBUILD_BINARY_PATH) {
  const bin = process.platform === "win32" ? "esbuild.exe" : join("bin", "esbuild");
  process.env.ESBUILD_BINARY_PATH = join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@esbuild", `${process.platform}-${process.arch}`, bin);
}
