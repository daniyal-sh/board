import { BrowserWindow } from "electron";

/**
 * Tile frames into one labelled image (a contact sheet), so the assistant reviews a whole scene
 * in one picture instead of a dozen. Drawn in a hidden window so no image library is needed.
 */
export async function contactSheet(frames: { png: Buffer; label: string }[], opts: { cols?: number; cellWidth?: number; aspect?: number } = {}): Promise<Buffer> {
  if (!frames.length) throw new Error("No frames");
  const aspect = opts.aspect ?? 16 / 9;
  const cols = opts.cols ?? (aspect < 1 ? Math.min(6, frames.length) : Math.min(frames.length <= 4 ? 2 : 3, frames.length));
  const cellW = opts.cellWidth ?? (aspect < 1 ? 220 : 400);
  const cellH = Math.round(cellW / aspect);
  const rows = Math.ceil(frames.length / cols);
  const labelH = 34;
  const gap = 8;
  const width = cols * cellW + (cols + 1) * gap;
  const height = rows * (cellH + labelH) + (rows + 1) * gap;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;overflow:hidden;background:#18181b;font:500 12px/1.3 system-ui,sans-serif;color:#e4e4e7}
    .g{display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:${gap}px;padding:${gap}px}
    .c{width:${cellW}px}
    img{display:block;width:${cellW}px;height:${cellH}px;object-fit:contain;background:#000;border-radius:4px}
    .l{box-sizing:border-box;height:${labelH}px;padding-top:4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    b{color:#fff;margin-right:4px}
  </style></head><body><div class="g">${frames
    .map((f, i) => `<div class="c"><img src="data:image/png;base64,${f.png.toString("base64")}"><div class="l"><b>${i + 1}</b>${esc(f.label)}</div></div>`)
    .join("")}</div></body></html>`;
  const win = new BrowserWindow({ show: false, width, height, useContentSize: true, webPreferences: { offscreen: true, sandbox: true, javascript: false } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((r) => setTimeout(r, 150));
    return (await win.webContents.capturePage()).toPNG();
  } finally {
    win.destroy();
  }
}

/** Pick at most `max` items, spread evenly, always keeping the last. */
export function spread<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  return [...new Set(out)];
}
