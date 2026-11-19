// Produce a flat, symlink-free, pruned copy of packages/lab-kit (with its vendored libraries)
// for the installer.
//  1. pnpm deploy with a hoisted layout (pnpm's default symlinked layout can't be shipped).
//  2. Bundle one entry that imports every library a Lab may use, and keep only the packages
//     esbuild actually reaches. manim-web alone pulls in hundreds of MB of tooling that Labs
//     never load.
import { execSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "apps", "desktop", "build", "lab-kit");
const nm = join(out, "node_modules");
const esbuild = createRequire(join(root, "apps", "desktop", "package.json"))("esbuild");

fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
execSync(`pnpm --filter @studio/lab-kit deploy --prod --config.node-linker=hoisted "${out}"`, { cwd: root, stdio: "inherit" });

// Everything the builder lets Labs import (keep in sync with apps/desktop/src/main/build/bundle.ts and the guides).
const entry = join(out, "__reach__.ts");
fs.writeFileSync(
  entry,
  [
    'import "./src/index.ts";',
    'import "./src/math.ts";',
    'import "jsxgraph"; import "jsxgraph/distrib/jsxgraph.css";',
    'import "d3"; import "@observablehq/plot";',
    'import "matter-js"; import "gsap";',
    'import "three"; import "three/examples/jsm/controls/OrbitControls.js";',
    'import "manim-web";',
  ].join("\n"),
);
const result = await esbuild.build({
  entryPoints: [entry],
  absWorkingDir: out,
  bundle: true,
  write: false,
  outdir: join(out, ".reach"),
  format: "esm",
  platform: "browser",
  metafile: true,
  logLevel: "silent",
  loader: { ".woff2": "dataurl", ".woff": "empty", ".ttf": "empty" },
  plugins: [
    {
      name: "deep-css",
      setup(b) {
        b.onResolve({ filter: /^[^./].*\.css$/ }, (a) => {
          const p = join(nm, a.path);
          return fs.existsSync(p) ? { path: p } : undefined;
        });
      },
    },
    {
      name: "drop-mathjax",
      setup(b) {
        b.onResolve({ filter: /MathJaxBundle-[\w-]+\.js$/ }, (a) => ({ path: a.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "", loader: "js" }));
      },
    },
  ],
});
fs.rmSync(entry);

const keep = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input.replaceAll("\\", "/"));
  if (m) keep.add(m[1]);
}
// Three.js examples are imported by many different paths; keep the whole package.
keep.add("three");

let removed = 0;
for (const name of fs.readdirSync(nm)) {
  if (name === ".bin" || name === ".pnpm" || name.startsWith(".")) {
    fs.rmSync(join(nm, name), { recursive: true, force: true });
    continue;
  }
  const scoped = name.startsWith("@") ? fs.readdirSync(join(nm, name)).map((s) => `${name}/${s}`) : [name];
  for (const pkg of scoped) {
    if (!keep.has(pkg)) {
      fs.rmSync(join(nm, pkg), { recursive: true, force: true });
      removed++;
    }
  }
  if (name.startsWith("@") && fs.existsSync(join(nm, name)) && !fs.readdirSync(join(nm, name)).length) fs.rmSync(join(nm, name), { recursive: true });
}

// Files inside kept packages that builds never load.
const trims = [
  "three/src", // build/ is self-contained; examples import "three"
  "manim-web/node_modules/three/src",
  "manim-web/dist/manim-web.browser.js", // Labs use the ES modules
];
for (const t of trims) fs.rmSync(join(nm, t), { recursive: true, force: true });
for (const f of fs.readdirSync(join(nm, "manim-web", "dist"))) {
  if (/^MathJaxBundle-/.test(f)) fs.rmSync(join(nm, "manim-web", "dist", f)); // stubbed out by the builder
}
for (const f of fs.readdirSync(join(nm, "jsxgraph", "distrib"))) {
  if (f !== "jsxgraph.css") fs.rmSync(join(nm, "jsxgraph", "distrib", f), { recursive: true }); // Labs import src/
}

// Source maps and markdown are not needed at runtime.
(function prune(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) prune(p);
    else if (/\.(map|md|d\.ts\.map)$/i.test(e.name)) fs.rmSync(p);
  }
})(nm);

// electron-builder drops node_modules folders from extraResources, so ship one archive;
// the app unpacks it into its data folder on first launch.
const archive = join(root, "apps", "desktop", "build", "lab-kit.tgz");
fs.rmSync(archive, { force: true });
const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
execSync(`"${tar}" -czf "${archive}" -C "${join(out, "..")}" lab-kit`, { stdio: "inherit" });

function size(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? size(join(dir, e.name)) : fs.statSync(join(dir, e.name)).size;
  return n;
}
console.log(`Archive: ${(fs.statSync(archive).size / 1e6).toFixed(0)} MB`);
console.log(`Vendored lab kit: kept ${keep.size} packages (${[...keep].sort().join(", ")}), removed ${removed}; ${(size(out) / 1e6).toFixed(0)} MB`);
