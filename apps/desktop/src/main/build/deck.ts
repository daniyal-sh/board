import fs from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type * as esbuild from "esbuild";
import { animationKind, type ProjectManifest } from "@studio/shared";
import { assemble, bundle, detectLibraries, loadNarration, type BundleResult } from "./bundle";
import { timeline as videoTimeline } from "../video/renderer";

/**
 * Slides: every slide in scenes/ becomes one page with the deck runtime from lab-kit.
 *
 * The generated entry (build/deck/entry.ts) imports the deck runtime, then each slide in order:
 * an HTML slide is a virtual module that inserts its markup as it loads (so its own script,
 * imported right after, finds its elements); animated slides go to one animator (manim-web
 * modules, or rendered Manim clips with their stops).
 */

export type DeckMedia =
  /** Preview in the app: clips load from build/scenes over the preview protocol. */
  | { mode: "preview" }
  /** One file: clips are inlined as data URLs. */
  | { mode: "inline" }
  /** A page plus a folder of clips next to it. */
  | { mode: "folder"; folder: string };

export interface DeckBuild extends BundleResult {
  /** Folder export: clips to copy next to the page (published path → source file). */
  media?: Record<string, string>;
  slides: { id: string; type: "html" | "animation" | "missing"; title: string }[];
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

interface ParsedSlide {
  html: string;
  css: string;
  script: string;
  cls: string;
}

/** Split an HTML slide file into markup, its <style> and its <script type="module">. */
export function parseHtmlSlide(src: string, sceneDir: string): ParsedSlide {
  let text = src;
  // A whole document by mistake: keep what's inside <body>.
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(text);
  if (body) {
    const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(text)?.[1] ?? "";
    text = head.replace(/<(meta|title|link)\b[^>]*>(?:[\s\S]*?<\/title>)?/gi, "") + body[1];
  }
  const css: string[] = [];
  const script: string[] = [];
  text = text.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, c: string) => {
    css.push(c);
    return "";
  });
  text = text.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_m, c: string) => {
    script.push(c);
    return "";
  });
  const cls = /<!--\s*class:\s*([\w\s-]+?)\s*-->/i.exec(text)?.[1] ?? "";
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // Local images and media become data URLs: the deck is one file with no network.
  const inline = (url: string) => {
    if (/^(data:|https?:|blob:|#)/i.test(url)) return url;
    const file = join(sceneDir, url.replace(/^\.\//, "").split(/[?#]/)[0]);
    const mime = MIME[extname(file).toLowerCase()];
    if (!mime || !fs.existsSync(file)) return url;
    return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  };
  text = text.replace(/\b(src|poster)=(["'])([^"']+)\2/gi, (_m, attr: string, q: string, url: string) => `${attr}=${q}${inline(url)}${q}`);
  const style = css.join("\n").replace(/url\((["']?)([^)"']+)\1\)/g, (_m, q: string, url: string) => `url(${q}${inline(url)}${q})`);
  return { html: text.trim(), css: style, script: script.join("\n"), cls };
}

function deckPlugin(sceneDir: string): esbuild.Plugin {
  return {
    name: "board-deck-slides",
    setup(build) {
      build.onResolve({ filter: /^deck-(html|script):/ }, (args) => {
        const [ns, ...rest] = args.path.split(":");
        return { path: rest.join(":"), namespace: ns };
      });
      build.onLoad({ filter: /.*/, namespace: "deck-html" }, (args) => {
        const p = parseHtmlSlide(fs.readFileSync(args.path, "utf8"), sceneDir);
        const id = basename(args.path, ".html");
        return {
          contents: `import { insertSlide } from "@studio/lab-kit/deck";\ninsertSlide(${JSON.stringify(id)}, ${JSON.stringify(p.html)}, ${JSON.stringify(p.css)}, ${JSON.stringify(p.cls)});\n`,
          loader: "js",
          resolveDir: sceneDir,
        };
      });
      build.onLoad({ filter: /.*/, namespace: "deck-script" }, (args) => ({
        contents: parseHtmlSlide(fs.readFileSync(args.path, "utf8"), sceneDir).script,
        loader: "ts",
        resolveDir: sceneDir,
      }));
    },
  };
}

function readNotes(dir: string, id: string): string {
  try {
    return fs.readFileSync(join(dir, "notes", `${id}.md`), "utf8").trim();
  } catch {
    return "";
  }
}

/** Stops of a rendered Manim slide, in seconds into its clip. */
function clipStops(projectId: string, id: string, quality: "draft" | "final"): { duration: number; stops: { t: number; loop?: boolean }[] } | null {
  const tl = videoTimeline(projectId, id, quality);
  if (!tl) return null;
  return { duration: tl.duration, stops: tl.plays.filter((p) => p.kind === "stop").map((p) => ({ t: p.end, loop: Boolean(p.loop) })) };
}

/**
 * Build the deck page. `quality` picks which Manim renders to use (drafts for the preview, the
 * high-quality renders for exports); missing renders show as a placeholder slide.
 */
export async function buildDeck(projectId: string, dir: string, m: ProjectManifest, opts: { preview: boolean; media: DeckMedia; quality: "draft" | "final" }): Promise<DeckBuild> {
  const engine = animationKind(m) ?? "web";
  const sceneDir = join(dir, "scenes");
  const slides = m.scenes;
  if (!slides.length) return { ok: false, libraries: [], errors: ["No slides yet: add scenes/01_<name>.html"], warnings: [], slides: [] };

  const outDir = join(dir, "build", "deck");
  fs.mkdirSync(outDir, { recursive: true });
  const rel = (f: string) => relative(outDir, f).replaceAll("\\", "/");
  const lines: string[] = ['import { runDeck } from "@studio/lab-kit/deck";'];
  if (fs.existsSync(join(sceneDir, "_theme.css"))) lines.push(`import ${JSON.stringify(rel(join(sceneDir, "_theme.css")))};`);
  const defs: string[] = [];
  const webSlides: string[] = [];
  const clips: { id: string; src: string; duration: number; stops: { t: number; loop?: boolean }[] }[] = [];
  const media: Record<string, string> = {};
  const report: DeckBuild["slides"] = [];

  for (const [n, s] of slides.entries()) {
    const file = join(dir, s.file);
    const notes = JSON.stringify(readNotes(dir, s.id));
    const meta = `id: ${JSON.stringify(s.id)}, title: ${JSON.stringify(s.title)}, notes: ${notes}`;
    if (s.slideType === "html") {
      const fwd = file.replaceAll("\\", "/");
      lines.push(`import "deck-html:${fwd}";`);
      const hasScript = parseHtmlSlide(fs.readFileSync(file, "utf8"), sceneDir).script.trim().length > 0;
      if (hasScript) lines.push(`import * as slide${n} from "deck-script:${fwd}";`);
      defs.push(`{ ${meta}, type: "html"${hasScript ? `, module: slide${n} as any` : ""} }`);
      report.push({ id: s.id, type: "html", title: s.title });
    } else if (engine === "web") {
      lines.push(`import slide${n} from ${JSON.stringify(rel(file).replace(/\.ts$/, ""))};`);
      webSlides.push(`{ id: ${JSON.stringify(s.id)}, run: slide${n} as any }`);
      defs.push(`{ ${meta}, type: "animation" }`);
      report.push({ id: s.id, type: "animation", title: s.title });
    } else {
      const sub = opts.quality === "draft" ? "scenes" : "final";
      const mp4 = join(dir, "build", sub, `${s.id}.mp4`);
      const info = clipStops(projectId, s.id, opts.quality);
      if (!info || !fs.existsSync(mp4)) {
        const message = opts.quality === "draft" ? "Not rendered yet. Ask the assistant to render this slide." : "This slide could not be rendered.";
        defs.push(`{ ${meta}, type: "missing", message: ${JSON.stringify(message)} }`);
        report.push({ id: s.id, type: "missing", title: s.title });
        continue;
      }
      let src: string;
      if (opts.media.mode === "preview") src = `scenes/${s.id}.mp4?v=${Math.round(fs.statSync(mp4).mtimeMs)}`;
      else if (opts.media.mode === "inline") src = `data:video/mp4;base64,${fs.readFileSync(mp4).toString("base64")}`;
      else {
        src = `${opts.media.folder}/${s.id}.mp4`;
        media[src] = mp4;
      }
      clips.push({ id: s.id, src, ...info });
      defs.push(`{ ${meta}, type: "animation" }`);
      report.push({ id: s.id, type: "animation", title: s.title });
    }
  }

  const vertical = m.aspect === "vertical";
  let animator = "undefined";
  if (engine === "web" && webSlides.length) {
    lines.push('import { createWebAnimator } from "@studio/lab-kit/deck-web";');
    const narration = loadNarration(dir, slides.filter((s) => s.slideType === "animation").map((s) => s.id));
    animator = `createWebAnimator([${webSlides.join(", ")}], ${JSON.stringify(narration)}, { vertical: ${vertical} })`;
  } else if (engine === "video" && clips.length) {
    lines.push('import { createVideoAnimator } from "@studio/lab-kit/deck-video";');
    animator = `createVideoAnimator(${JSON.stringify(clips)})`;
  }
  lines.push(
    "",
    `void runDeck({ title: ${JSON.stringify(m.title)}, aspect: ${JSON.stringify(vertical ? "vertical" : "landscape")}, animator: ${animator}, slides: [\n  ${defs.join(",\n  ")},\n] });`,
    "",
  );
  const entry = join(outDir, "entry.ts");
  fs.writeFileSync(entry, `// Generated by Board on every build. Do not edit.\n${lines.join("\n")}`);

  const out = await bundle(entry, dir, [deckPlugin(sceneDir)]);
  if (out.errors.length) return { ok: false, libraries: [], errors: out.errors, warnings: out.warnings, slides: report };
  const libraries = detectLibraries(out.meta);
  const html = assemble(deckShellHtml(m.title), out.js, out.css, opts.preview, libraries);
  return { ok: true, html, sizeBytes: Buffer.byteLength(html), libraries, errors: [], warnings: out.warnings, media, slides: report };
}

export function deckShellHtml(title: string): string {
  const safe = title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safe}</title>
<!-- manim-web draws its maths itself; this stops it fetching KaTeX's stylesheet from a CDN (the page works offline). -->
<style id="manimweb-katex-styles"></style>
</head>
<body>
<script type="module" src="./main.ts"></script>
</body>
</html>
`;
}
