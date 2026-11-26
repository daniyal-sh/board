import { BrowserWindow, screen } from "electron";
import { IPC } from "@studio/shared";
import { deckUrl } from "./build/preview";
import { mainWindow } from "./window";

/**
 * Presenting slides from the app. The deck runs in an audience window (full screen on a second
 * display when there is one). The app's presenter view shows a live picture of that window, the
 * next step and the notes, and drives it: next/back, ink tools, and clicks and drags on the
 * picture are passed through to the audience window, so interactive slides work from the
 * presenter screen too. Only the audience window runs the slides, so what students see is what
 * the teacher sees.
 */
interface Session {
  projectId: string;
  win: BrowserWindow;
  timer: NodeJS.Timeout | null;
  capturing: boolean;
}

let session: Session | null = null;

const send = (channel: string, payload?: unknown) => mainWindow()?.webContents.send(channel, payload);

export function startPresenting(projectId: string, opts: { slide?: string; step?: number; windowed?: boolean }): { external: boolean } {
  stopPresenting();
  const main = mainWindow();
  const here = main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
  const other = screen.getAllDisplays().find((d) => d.id !== here.id);
  const target = opts.windowed ? here : (other ?? here);
  const b = target.bounds;
  const windowed = Boolean(opts.windowed);
  const win = new BrowserWindow({
    x: windowed ? Math.round(b.x + b.width * 0.1) : b.x,
    y: windowed ? Math.round(b.y + b.height * 0.1) : b.y,
    width: windowed ? Math.round(b.width * 0.62) : b.width,
    height: windowed ? Math.round(b.width * 0.62 * 9 / 16) : b.height,
    fullscreen: !windowed,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    title: "Slides",
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.on("console-message", (e) => {
    const msg = (e as unknown as { message: string }).message;
    if (!msg.startsWith("__board_deck__")) return;
    try {
      const d = JSON.parse(msg.slice("__board_deck__".length)) as { type: string };
      if (d.type === "state") send(IPC.presentState, d);
      else if (d.type === "ready") send(IPC.presentReady, d);
      else if (d.type === "exit") stopPresenting();
    } catch {
      /* not ours */
    }
  });
  win.on("closed", () => {
    if (session?.win === win) {
      if (session.timer) clearInterval(session.timer);
      session = null;
      send(IPC.presentEnded);
    }
  });
  const q = ["present=1", opts.slide ? `slide=${encodeURIComponent(opts.slide)}&step=${opts.step ?? 0}` : ""].filter(Boolean).join("&");
  void win.loadURL(deckUrl(projectId, q));
  win.once("ready-to-show", () => {
    win.show();
    // The presenter keeps the keyboard when the audience screen is elsewhere.
    if (other && !windowed) main?.focus();
  });
  session = { projectId, win, timer: null, capturing: false };
  // A live picture of the audience screen for the presenter view, about 8 times a second.
  session.timer = setInterval(() => void captureFrame(), 125);
  return { external: Boolean(other) && !windowed };
}

async function captureFrame(): Promise<void> {
  const s = session;
  if (!s || s.capturing || s.win.isDestroyed()) return;
  s.capturing = true;
  try {
    const img = await s.win.webContents.capturePage();
    if (img.isEmpty()) return;
    const small = img.getSize().width > 1280 ? img.resize({ width: 1280 }) : img;
    send(IPC.presentFrame, `data:image/jpeg;base64,${small.toJPEG(72).toString("base64")}`);
  } catch {
    /* the window is closing */
  } finally {
    s.capturing = false;
  }
}

/** next, prev, goto, tool, color, clear, blank: the deck's own message commands. */
export function presentCommand(cmd: Record<string, unknown>): void {
  const w = session?.win;
  if (!w || w.isDestroyed()) return;
  void w.webContents.executeJavaScript(`window.postMessage(${JSON.stringify({ __studio: 1, type: "deck", ...cmd })}, "*")`).catch(() => {});
}

/** A pointer on the presenter's picture, as 0..1 of the audience screen. */
export function presentInput(ev: { type: "down" | "move" | "up"; x: number; y: number; buttons?: number }): void {
  const w = session?.win;
  if (!w || w.isDestroyed()) return;
  const [cw, ch] = w.getContentSize();
  const x = Math.round(Math.max(0, Math.min(1, ev.x)) * cw);
  const y = Math.round(Math.max(0, Math.min(1, ev.y)) * ch);
  if (ev.type === "down") w.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  else if (ev.type === "up") w.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  else if (ev.buttons) w.webContents.sendInputEvent({ type: "mouseMove", x, y, button: "left", modifiers: ["leftbuttondown"] });
  else w.webContents.sendInputEvent({ type: "mouseMove", x, y });
}

export function stopPresenting(): void {
  const s = session;
  if (!s) return;
  session = null;
  if (s.timer) clearInterval(s.timer);
  if (!s.win.isDestroyed()) s.win.close();
  send(IPC.presentEnded);
}

export function presentingProject(): string | null {
  return session?.projectId ?? null;
}
