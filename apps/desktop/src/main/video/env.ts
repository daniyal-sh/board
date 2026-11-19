import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { paths } from "../paths";

/**
 * The private Python environment used for Manim videos, created on first use:
 *   <userData>/runtime/bin/uv            downloaded uv binary
 *   <userData>/runtime/venv              Python 3.12 + manim + studio_manim
 *   <userData>/runtime/tinytex           LaTeX for MathTex/Tex
 */
const isWin = process.platform === "win32";

export const runtime = {
  get root() {
    return join(paths.dataDir, "runtime");
  },
  get uv() {
    return join(this.root, "bin", isWin ? "uv.exe" : "uv");
  },
  get venv() {
    return join(this.root, "venv");
  },
  get python() {
    return isWin ? join(this.venv, "Scripts", "python.exe") : join(this.venv, "bin", "python");
  },
  get tinytex() {
    return join(this.root, "tinytex");
  },
  /** Folder with the latex/dvisvgm binaries, or undefined when LaTeX is not installed. */
  get texBin(): string | undefined {
    const base = join(this.tinytex, "TinyTeX", "bin");
    if (!fs.existsSync(base)) return undefined;
    const sub = fs.readdirSync(base)[0];
    return sub ? join(base, sub) : undefined;
  },
};

export interface VideoEnvStatus {
  uv: boolean;
  python: boolean;
  manim: boolean;
  latex: boolean;
  ready: boolean;
}

export function videoEnvStatus(): VideoEnvStatus {
  const uv = fs.existsSync(runtime.uv);
  const python = fs.existsSync(runtime.python);
  const manim = python && fs.existsSync(join(runtime.root, "manim.ok"));
  const latex = Boolean(runtime.texBin) && fs.existsSync(join(runtime.root, "latex.ok"));
  return { uv, python, manim, latex, ready: python && manim };
}

/** Environment for running Manim: TinyTeX on PATH, Studio plugin importable. */
export function manimEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const pathParts = [runtime.texBin, process.env.PATH].filter(Boolean) as string[];
  return {
    ...process.env,
    PATH: pathParts.join(isWin ? ";" : ":"),
    PYTHONPATH: [paths.pythonPluginDir, process.env.PYTHONPATH].filter(Boolean).join(isWin ? ";" : ":"),
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    ...extra,
  };
}

/** Windows ships bsdtar as System32\tar.exe; a GNU tar earlier on PATH (e.g. Git's) can't read "C:\\" paths. */
const TAR = isWin ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

function uvAsset(): string {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (isWin) return `uv-${arch}-pc-windows-msvc.zip`;
  if (process.platform === "darwin") return `uv-${arch}-apple-darwin.tar.gz`;
  return `uv-${arch}-unknown-linux-gnu.tar.gz`;
}

function exec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (l: string) => void } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true });
    let tail = "";
    const onData = (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-3000);
      for (const line of s.split(/\r?\n/)) if (line.trim()) opts.onLine?.(line.trim());
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} failed (${code}):\n${tail}`))));
  });
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  fs.mkdirSync(join(dest, ".."), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Packages Manim needs from TeX Live on top of TinyTeX. */
const TEX_PACKAGES = [
  "standalone", "preview", "doublestroke", "ms", "everysel", "setspace", "rsfs", "relsize", "ragged2e",
  "fundus-calligra", "microtype", "wasysym", "physics", "dvisvgm", "jknapltx", "wasy", "cm-super",
  "babel-english", "gnu-freefont", "mathastext", "cbfonts-fd", "xcolor", "amsfonts",
];

export type SetupStep = "uv" | "python" | "manim" | "latex" | "done";

/** Install everything needed for videos. Safe to run again; finished steps are skipped. */
export async function setupVideoEnv(progress: (step: SetupStep, message: string) => void): Promise<VideoEnvStatus> {
  fs.mkdirSync(runtime.root, { recursive: true });

  if (!fs.existsSync(runtime.uv)) {
    progress("uv", "Downloading the Python installer (uv)…");
    const asset = uvAsset();
    const archive = join(os.tmpdir(), asset);
    await download(`https://github.com/astral-sh/uv/releases/latest/download/${asset}`, archive);
    const out = join(runtime.root, "bin");
    fs.mkdirSync(out, { recursive: true });
    // bsdtar (bundled with Windows 10+, macOS and most Linux) extracts both zip and tar.gz.
    await exec(TAR, ["-xf", archive, "-C", out, ...(isWin ? [] : ["--strip-components=1"])]);
    if (!isWin) fs.chmodSync(runtime.uv, 0o755);
  }

  const uvEnv = { ...process.env, UV_PYTHON_INSTALL_DIR: join(runtime.root, "pythons"), UV_CACHE_DIR: join(runtime.root, "cache") };
  if (!fs.existsSync(runtime.python)) {
    progress("python", "Installing Python 3.12…");
    await exec(runtime.uv, ["venv", "--python", "3.12", "--seed", runtime.venv], { env: uvEnv, onLine: (l) => progress("python", l) });
  }

  if (!fs.existsSync(join(runtime.root, "manim.ok"))) {
    progress("manim", "Installing Manim (this takes a minute)…");
    await exec(runtime.uv, ["pip", "install", "--python", runtime.python, "manim>=0.19"], { env: uvEnv, onLine: (l) => progress("manim", l) });
    fs.writeFileSync(join(runtime.root, "manim.ok"), new Date().toISOString());
  }

  if (!runtime.texBin) {
    progress("latex", "Downloading LaTeX (TinyTeX)…");
    // Asset names carry the release version, e.g. TinyTeX-1-windows-v2026.11.exe
    const pattern = isWin
      ? /^TinyTeX-1-windows-v[\d.]+\.exe$/
      : process.platform === "darwin"
        ? /^TinyTeX-1-darwin-v[\d.]+\.tar\.xz$/
        : process.arch === "arm64"
          ? /^TinyTeX-1-linux-arm64-v[\d.]+\.tar\.xz$/
          : /^TinyTeX-1-linux-x86_64-v[\d.]+\.tar\.xz$/;
    const release = (await (await fetch("https://api.github.com/repos/rstudio/tinytex-releases/releases/latest")).json()) as {
      assets: { name: string; browser_download_url: string }[];
    };
    const asset = release.assets.find((a) => pattern.test(a.name));
    if (!asset) throw new Error("Could not find a LaTeX download for this computer.");
    const archive = join(os.tmpdir(), asset.name);
    await download(asset.browser_download_url, archive);
    fs.mkdirSync(runtime.tinytex, { recursive: true });
    if (isWin) {
      // Self-extracting 7z archive: -o<dir> -y
      await exec(archive, [`-o${runtime.tinytex}`, "-y"]);
    } else {
      await exec(TAR, ["-xJf", archive, "-C", runtime.tinytex]);
      if (!fs.existsSync(join(runtime.tinytex, "TinyTeX")) && fs.existsSync(join(runtime.tinytex, ".TinyTeX"))) {
        fs.renameSync(join(runtime.tinytex, ".TinyTeX"), join(runtime.tinytex, "TinyTeX"));
      }
    }
    if (!runtime.texBin) throw new Error("LaTeX could not be unpacked.");
  }
  if (!fs.existsSync(join(runtime.root, "latex.ok"))) await installTexPackages(progress);

  progress("done", "Ready to make videos.");
  return videoEnvStatus();
}

/** tlmgr must update itself before it will install anything; its .bat wrapper exits 0 even on failure, so verify. */
async function installTexPackages(progress: (step: SetupStep, message: string) => void): Promise<void> {
  const bin = runtime.texBin!;
  const tool = (name: string) => join(bin, isWin ? `${name}.bat` : name);
  const run = (args: string[]) =>
    exec(isWin ? "cmd.exe" : tool("tlmgr"), isWin ? ["/c", tool("tlmgr"), ...args] : args, { onLine: (l) => progress("latex", l) });
  progress("latex", "Updating the LaTeX package manager…");
  await run(["update", "--self"]);
  progress("latex", "Adding LaTeX packages Manim needs…");
  await run(["install", ...TEX_PACKAGES]);
  const missing: string[] = [];
  for (const file of ["standalone.cls", "preview.sty", "dsfont.sty", "physics.sty", "relsize.sty"]) {
    const out = await new Promise<string>((resolve) => {
      const kpse = join(bin, isWin ? "kpsewhich.exe" : "kpsewhich");
      const child = spawn(kpse, [file], { windowsHide: true });
      let s = "";
      child.stdout.on("data", (d) => (s += d));
      child.on("close", () => resolve(s.trim()));
      child.on("error", () => resolve(""));
    });
    if (!out) missing.push(file);
  }
  const dvisvgm = fs.existsSync(join(bin, isWin ? "dvisvgm.exe" : "dvisvgm"));
  if (missing.length || !dvisvgm) {
    throw new Error(`Some LaTeX parts are missing (${[...missing, ...(dvisvgm ? [] : ["dvisvgm"])].join(", ")}). Check your internet connection and try again.`);
  }
  fs.writeFileSync(join(runtime.root, "latex.ok"), new Date().toISOString());
}
