import fs from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type * as esbuild from "esbuild";
import type { Aspect, ProjectKind } from "@studio/shared";
import { paths } from "../paths";
import { PREVIEW_BRIDGE } from "./bridge";
import { webRunnerSource, webShellHtml, type SceneNarration } from "./web-runner";

export interface BundleResult {
  ok: boolean;
  html?: string;
  sizeBytes?: number;
  libraries: string[];
  errors: string[];
  warnings: string[];
}

/** Libraries a Lab may import; anything else under node_modules is reported as a dependency of these. */
const KNOWN_LIBS = ["katex", "jsxgraph", "d3", "@observablehq/plot", "three", "matter-js", "gsap", "manim-web", "p5", "roughjs"];

/** KaTeX's CSS lists woff2, woff and ttf fonts; keep only woff2 so the single file stays small. */
/**
 * Some packages hide files behind an "exports" map (e.g. jsxgraph/distrib/jsxgraph.css).
 * Labs need those stylesheets, so resolve deep CSS imports straight from the vendored folder.
 */
const deepCssPlugin: esbuild.Plugin = {
  name: "vendored-deep-css",
  setup(build) {
    build.onResolve({ filter: /^[^./].*\.css$/ }, (args) => {
      const p = join(libsNodeModules(), args.path);
      return fs.existsSync(p) ? { path: fs.realpathSync(p) } : undefined;
    });
  },
};

/**
 * manim-web lazily imports an 11 MB MathJax bundle as a fallback renderer inside a try/catch.
 * A single-file build would inline it, so swap in a stub that throws; manim-web then uses the
 * smaller MathJax that assemble() puts on the page.
 */
const dropMathJaxPlugin: esbuild.Plugin = {
  name: "drop-mathjax-fallback",
  setup(build) {
    build.onResolve({ filter: /MathJaxBundle-[\w-]+\.js$/ }, (args) => ({ path: args.path, namespace: "studio-stub" }));
    build.onLoad({ filter: /.*/, namespace: "studio-stub" }, () => ({
      contents: 'throw new Error("The MathJax bundle of manim-web is left out of Board builds; the MathJax on the page is used instead.");',
      loader: "js",
    }));
  },
};

/**
 * p5.js 2.x fetches its friendly-error translations as soon as it loads (a local JSON file, then
 * a CDN), even with friendly errors off. Pages are offline: skip the fetch. (IS_MINIFIED, defined
 * below, turns the friendly-error checks off as in p5's own minified build; they misread a
 * bundled page and warn about "redeclared" constants that are not the teacher's code.)
 */
const p5OfflinePlugin: esbuild.Plugin = {
  name: "p5-offline-translations",
  setup(build) {
    build.onLoad({ filter: /[\\/]p5[\\/]dist[\\/]fes-[\w-]+\.js$/ }, async (args) => {
      const js = await fs.promises.readFile(args.path, "utf8");
      return { contents: js.replace(/let translationPromise = new Promise\(async \(resolve\) => \{[\s\S]*?\n\}\);/, "let translationPromise = Promise.resolve();"), loader: "js" };
    });
  },
};

const katexFontsPlugin: esbuild.Plugin = {
  name: "katex-woff2-only",
  setup(build) {
    build.onLoad({ filter: /katex(\.min)?\.css$/ }, async (args) => {
      const css = await fs.promises.readFile(args.path, "utf8");
      return {
        contents: css.replace(/,\s*url\([^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, ""),
        loader: "css",
      };
    });
  },
};

function libsNodeModules(): string {
  return join(paths.labKitDir, "node_modules");
}

function labKitAliases(): Record<string, string> {
  const src = join(paths.labKitDir, "src");
  return {
    "@studio/lab-kit/math": join(src, "math.ts"),
    "@studio/lab-kit/lab-kit.css": join(src, "lab-kit.css"),
    "@studio/lab-kit/base.css": join(src, "base.css"),
    "@studio/lab-kit/deck-web": join(src, "deck", "web.ts"),
    "@studio/lab-kit/deck-video": join(src, "deck", "video.ts"),
    "@studio/lab-kit/deck": join(src, "deck", "core.ts"),
    "@studio/lab-kit": join(src, "index.ts"),
  };
}

function formatMessage(m: esbuild.Message, cwd: string): string {
  const file = m.location?.file ?? "";
  const shown = (isAbsolute(file) ? relative(cwd, file) : file).replaceAll("\\", "/");
  const loc = m.location ? `${shown}:${m.location.line}:${m.location.column}: ` : "";
  return `${loc}${m.text}`;
}

export function detectLibraries(meta: esbuild.Metafile | undefined): string[] {
  if (!meta) return [];
  const found = new Set<string>();
  for (const input of Object.keys(meta.inputs)) {
    const p = input.replaceAll("\\", "/");
    for (const lib of KNOWN_LIBS) if (p.includes(`/node_modules/${lib}/`) || p.includes(`node_modules/.pnpm/${lib.replace("/", "+")}@`)) found.add(lib);
  }
  return [...found];
}

/**
 * Make code safe to inline. Inside a <script>, "</script", "<script" and "<!--" change how the HTML
 * parser reads the rest of the element. They can only occur inside strings, regexes or comments,
 * where the JS escape \x3C means the same "<", so swap it in.
 */
export function inlineSafe(code: string, tag: "script" | "style"): string {
  if (tag === "style") return code.replace(/<\/style/gi, "\\3C/style");
  return code.replace(/<(?=\/?script|!--)/gi, "\\x3C");
}

export async function bundle(entry: string, cwd: string, extraPlugins: esbuild.Plugin[] = []): Promise<{ js: string; css: string; meta?: esbuild.Metafile; errors: string[]; warnings: string[] }> {
  try {
    // Loaded lazily so ESBUILD_BINARY_PATH (set at startup for packaged apps) is already in place.
    const { build } = await import("esbuild");
    const result = await build({
      entryPoints: [entry],
      absWorkingDir: cwd,
      bundle: true,
      write: false,
      outdir: join(cwd, "build", ".esbuild"),
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      // Keep class names (Text, Circle…) so layout checks and error messages can name things.
      keepNames: true,
      legalComments: "none",
      metafile: true,
      logLevel: "silent",
      nodePaths: [libsNodeModules()],
      alias: labKitAliases(),
      plugins: [...extraPlugins, deepCssPlugin, dropMathJaxPlugin, katexFontsPlugin, p5OfflinePlugin],
      loader: {
        ".woff2": "dataurl",
        ".woff": "empty",
        ".ttf": "empty",
        ".png": "dataurl",
        ".jpg": "dataurl",
        ".jpeg": "dataurl",
        ".gif": "dataurl",
        ".webp": "dataurl",
        ".svg": "dataurl",
        ".mp3": "dataurl",
        ".wav": "dataurl",
        ".csv": "text",
        ".txt": "text",
        ".md": "text",
      },
      define: { "process.env.NODE_ENV": '"production"', IS_MINIFIED: "true" },
    });
    let js = "";
    let css = "";
    for (const f of result.outputFiles) {
      if (f.path.endsWith(".js")) js += f.text;
      else if (f.path.endsWith(".css")) css += f.text;
    }
    return {
      js,
      css,
      meta: result.metafile,
      errors: [],
      warnings: result.warnings.map((w) => formatMessage(w, cwd)),
    };
  } catch (e) {
    const failure = e as esbuild.BuildFailure;
    if (failure.errors) {
      return { js: "", css: "", errors: failure.errors.map((m) => formatMessage(m, cwd)), warnings: [] };
    }
    return { js: "", css: "", errors: [String((e as Error).message ?? e)], warnings: [] };
  }
}

/**
 * manim-web draws MathTex and Tex with MathJax. Its own 11 MB MathJax bundle is left out of builds
 * (see dropMathJaxPlugin) and its fallback loads MathJax from a CDN, which an offline page can't.
 * manim-web uses a MathJax that is already on the page, so pages with manim-web get MathJax's
 * TeX-to-SVG component (about 2 MB) inline, ahead of the bundle.
 */
let mathJaxSource: string | null = null;
function mathJaxScript(): string {
  if (mathJaxSource === null) {
    const file = join(libsNodeModules(), "mathjax", "es5", "tex-svg-full.js");
    mathJaxSource = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }
  if (!mathJaxSource) return "";
  const config = `window.MathJax = { tex: { packages: { "[+]": ["ams", "newcommand", "configmacros", "html"] } }, svg: { fontCache: "global" }, startup: { typeset: false } };`;
  return `<script>${inlineSafe(config, "script")}</script>\n<script>${inlineSafe(mathJaxSource, "script")}</script>\n`;
}

export function assemble(shell: string, js: string, css: string, preview: boolean, libraries: string[] = []): string {
  let html = shell.replace(/<script\b[^>]*\bsrc=["'][^"']*main\.(?:ts|js|mjs)["'][^>]*>\s*<\/script>/gi, "");
  const head =
    (preview ? `<script>${inlineSafe(PREVIEW_BRIDGE, "script")}</script>\n` : "") +
    (libraries.includes("manim-web") ? mathJaxScript() : "") +
    (css ? `<style>${inlineSafe(css, "style")}</style>\n` : "");
  const body = `<script type="module">${inlineSafe(js, "script")}</script>\n`;
  // Replacer functions, not strings: bundled code contains "$&" and "$'", which a replacement
  // string would treat as special patterns.
  html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${head}</head>`) : head + html;
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${body}</body>`) : html + body;
  return html;
}

/** Narration audio (inlined) and timing for the scenes that have it. */
export function loadNarration(dir: string, ids: string[]): Record<string, SceneNarration> {
  const narration: Record<string, SceneNarration> = {};
  for (const id of ids) {
    const json = join(dir, "build", "narration", `${id}.json`);
    const wav = join(dir, "build", "narration", `${id}.wav`);
    if (!fs.existsSync(json) || !fs.existsSync(wav)) continue;
    const n = JSON.parse(fs.readFileSync(json, "utf8")) as { marks: Record<string, number>; captions: SceneNarration["captions"]; duration: number };
    narration[id] = { audio: `data:audio/wav;base64,${fs.readFileSync(wav).toString("base64")}`, duration: n.duration, marks: n.marks, captions: n.captions };
  }
  return narration;
}

/**
 * Build a Lab or web animation into one HTML file.
 * `preview` adds the bridge used by the app (console capture, click-to-select).
 */
export async function buildSingleFile(dir: string, kind: ProjectKind, title: string, preview: boolean, aspect: Aspect = "landscape"): Promise<BundleResult> {
  let entry: string;
  let shell: string;
  if (kind === "lab") {
    const labDir = join(dir, "lab");
    entry = ["main.ts", "main.js", "main.mjs"].map((f) => join(labDir, f)).find((f) => fs.existsSync(f)) ?? "";
    if (!entry) return { ok: false, libraries: [], errors: ["lab/main.ts is missing"], warnings: [] };
    shell = fs.existsSync(join(labDir, "index.html"))
      ? fs.readFileSync(join(labDir, "index.html"), "utf8")
      : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>`;
  } else if (kind === "web") {
    const sceneDir = join(dir, "scenes");
    const files = fs.existsSync(sceneDir)
      ? fs.readdirSync(sceneDir).filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.startsWith("_")).sort()
      : [];
    if (!files.length) return { ok: false, libraries: [], errors: ["No scenes yet: add scenes/01_<name>.ts"], warnings: [] };
    entry = join(sceneDir, "index.ts");
    const narration = loadNarration(dir, files.map((f) => f.replace(/\.ts$/, "")));
    fs.writeFileSync(entry, webRunnerSource(files.map((file) => ({ file })), narration, aspect));
    shell = webShellHtml(title, aspect);
  } else {
    return { ok: false, libraries: [], errors: ["Videos are rendered with Manim, not bundled"], warnings: [] };
  }

  const out = await bundle(entry, dir);
  if (out.errors.length) return { ok: false, libraries: [], errors: out.errors, warnings: out.warnings };
  const libraries = detectLibraries(out.meta);
  const html = assemble(shell, out.js, out.css, preview, libraries);
  return {
    ok: true,
    html,
    sizeBytes: Buffer.byteLength(html),
    libraries,
    errors: [],
    warnings: out.warnings,
  };
}
