import type { BrowserWindow } from "electron";

/** The teacher's window, for tools that look at what the teacher is looking at. */
let main: BrowserWindow | null = null;

export function setMainWindow(w: BrowserWindow | null): void {
  main = w;
}

export function mainWindow(): BrowserWindow | null {
  return main && !main.isDestroyed() ? main : null;
}
