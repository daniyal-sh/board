import fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { BrowserWindow } from "electron";
import { projects } from "../projects";
import { buildDeckExport, deckPictures } from "./preview";

/** Above this, Manim clips go in a folder next to the page instead of inside it. */
const INLINE_LIMIT = 60 * 1024 * 1024;

/**
 * The deck as a page to share. Small decks are one self-contained file; when the rendered Manim
 * clips would make it huge, the page is saved with a folder of clips beside it (keep them together).
 */
export async function exportDeckHtml(projectId: string, outPath: string, progress: (m: string) => void, inlineLimit = INLINE_LIMIT): Promise<{ path: string; sizeBytes: number; folder?: string }> {
  // Clips are rendered (in high quality) by the first build; their size decides the layout.
  const folderName = `${basename(outPath).replace(/\.html?$/i, "")}_media`;
  const probe = await buildDeckExport(projectId, { mode: "folder", folder: folderName }, progress);
  const mediaBytes = Object.values(probe.media).reduce((n, f) => n + fs.statSync(f).size, 0);
  if (mediaBytes * 1.34 < inlineLimit) {
    const inline = await buildDeckExport(projectId, { mode: "inline" }, progress);
    fs.writeFileSync(outPath, inline.html);
    return { path: outPath, sizeBytes: inline.sizeBytes };
  }
  const folder = join(dirname(outPath), folderName);
  fs.mkdirSync(folder, { recursive: true });
  for (const [published, source] of Object.entries(probe.media)) fs.copyFileSync(source, join(dirname(outPath), published));
  fs.writeFileSync(outPath, probe.html);
  return { path: outPath, sizeBytes: probe.sizeBytes + mediaBytes, folder };
}

/** Build the deck with the high-quality clips, for pictures in the hidden window. */
async function picturesOf(projectId: string, perSlide: boolean, progress: (m: string) => void) {
  const dir = projects.dir(projectId);
  // The page sits in build/ and the clips in build/final/, so the deck finds them by relative path.
  const built = await buildDeckExport(projectId, { mode: "folder", folder: "final" }, progress);
  fs.writeFileSync(join(dir, "build", "deck-export.html"), built.html);
  return deckPictures(projectId, { page: "deck-export.html", perSlide, progress });
}

/** One page per step (or per slide), at the slide's own proportions. */
export async function exportDeckPdf(projectId: string, outPath: string, opts: { perSlide: boolean }, progress: (m: string) => void): Promise<{ path: string; pages: number }> {
  const pics = await picturesOf(projectId, opts.perSlide, progress);
  progress("Making the PDF…");
  const vertical = projects.manifest(projectId).aspect === "vertical";
  const [w, h] = vertical ? [1080, 1920] : [1920, 1080];
  const dir = join(projects.dir(projectId), "build", "pdf");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const pages = pics.map((p, i) => {
    const name = `${String(i).padStart(3, "0")}.png`;
    fs.writeFileSync(join(dir, name), p.png);
    return `<div class="page"><img src="${name}" alt=""></div>`;
  });
  fs.writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${w}px ${h}px; margin: 0; }
html, body { margin: 0; padding: 0; background: #000; }
.page { width: ${w}px; height: ${h}px; page-break-after: always; break-after: page; overflow: hidden; }
.page:last-child { page-break-after: auto; break-after: auto; }
img { display: block; width: ${w}px; height: ${h}px; }
</style></head><body>${pages.join("\n")}</body></html>`,
  );
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { offscreen: true, sandbox: true, javascript: false } });
  try {
    await win.loadFile(join(dir, "index.html"));
    // Inches at 96 px per inch, matching the CSS page size.
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: { width: w / 96, height: h / 96 }, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    fs.writeFileSync(outPath, pdf);
  } finally {
    win.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { path: outPath, pages: pics.length };
}

/** One PowerPoint slide per step (or per slide), each a full-bleed picture with the speaker notes. */
export async function exportDeckPptx(projectId: string, outPath: string, opts: { perSlide: boolean }, progress: (m: string) => void): Promise<{ path: string; slides: number }> {
  const pics = await picturesOf(projectId, opts.perSlide, progress);
  progress("Making the PowerPoint file…");
  const m = projects.manifest(projectId);
  const mod = await import("pptxgenjs");
  const PptxGenJS = (mod as unknown as { default: new () => PptxLike }).default;
  const pptx = new PptxGenJS();
  const vertical = m.aspect === "vertical";
  pptx.defineLayout({ name: "BOARD", width: vertical ? 7.5 : 13.333, height: vertical ? 13.333 : 7.5 });
  pptx.layout = "BOARD";
  pptx.title = m.title;
  pptx.company = "Made with Board";
  for (const p of pics) {
    const slide = pptx.addSlide();
    slide.background = { color: "000000" };
    slide.addImage({ data: `image/png;base64,${p.png.toString("base64")}`, x: 0, y: 0, w: "100%", h: "100%", altText: p.title });
    const where = p.steps > 1 && !opts.perSlide ? ` (step ${p.step + 1} of ${p.steps})` : "";
    if (p.notes || where) slide.addNotes(`${p.title}${where}${p.notes ? `\n\n${p.notes}` : ""}`);
  }
  const buf = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  fs.writeFileSync(outPath, buf);
  return { path: outPath, slides: pics.length };
}

/** The part of pptxgenjs used here (its types don't load under NodeNext resolution). */
interface PptxLike {
  defineLayout(l: { name: string; width: number; height: number }): void;
  layout: string;
  title: string;
  company: string;
  addSlide(): {
    background: { color: string };
    addImage(o: { data: string; x: number; y: number; w: string | number; h: string | number; altText?: string }): void;
    addNotes(text: string): void;
  };
  write(o: { outputType: "nodebuffer" }): Promise<unknown>;
}
