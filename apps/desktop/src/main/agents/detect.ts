import { execFile } from "node:child_process";
import { killTree, providerEnv, resolveCodexNative, spawnCli } from "./process";
import fs from "node:fs";
import os from "node:os";
import { delimiter, join } from "node:path";
import type { AgentProviderId, ProviderStatus } from "@studio/shared";

const isWin = process.platform === "win32";

/**
 * GUI apps on macOS/Linux start with a minimal PATH. Ask the login shell once for the real one,
 * so CLIs installed with npm, Homebrew or ~/.local/bin are found.
 */
let pathReady: Promise<void> | undefined;
export function ensureShellPath(): Promise<void> {
  if (isWin) return Promise.resolve();
  pathReady ??= new Promise<void>((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    execFile(shell, ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 8000 }, (_err, stdout) => {
      const m = /__PATH__(.*)__PATH__/.exec(stdout ?? "");
      if (m?.[1]) {
        const merged = new Set([...m[1].split(delimiter), ...(process.env.PATH ?? "").split(delimiter)]);
        process.env.PATH = [...merged].filter(Boolean).join(delimiter);
      }
      resolve();
    });
  });
  return pathReady;
}

const EXTRA_DIRS = [
  join(os.homedir(), ".local", "bin"),
  join(os.homedir(), ".claude", "local"),
  join(os.homedir(), ".npm-global", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  ...(isWin ? [join(process.env.APPDATA ?? "", "npm")] : []),
];

/** Find an executable on PATH (plus common install folders). */
export function findExecutable(name: string): string | undefined {
  const exts = isWin ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...EXTRA_DIRS].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

export function run(exe: string, args: string[], timeoutMs = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Probe the native binary when npm installed a shim, with the same clean environment as real runs.
    const target = (/codex/i.test(exe) && resolveCodexNative(exe)) || exe;
    const child = spawnCli(target, args, { stdio: ["ignore", "pipe", "pipe"], env: providerEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const LABELS: Record<AgentProviderId, string> = { claude: "Claude Code", codex: "Codex" };
const BIN: Record<AgentProviderId, string> = { claude: "claude", codex: "codex" };

let cache: ProviderStatus[] | undefined;

async function check(id: AgentProviderId): Promise<ProviderStatus> {
  const exe = findExecutable(BIN[id]);
  if (!exe) {
    return {
      id,
      label: LABELS[id],
      installed: false,
      message: id === "claude" ? "Install Claude Code from claude.com/code, then sign in." : "Install Codex (npm i -g @openai/codex), then sign in.",
    };
  }
  const version = (await run(exe, ["--version"])).stdout.trim().split(/\s+/)[0];
  let authenticated: boolean | undefined;
  let message: string | undefined;
  if (id === "claude") {
    const r = await run(exe, ["auth", "status"]);
    try {
      authenticated = Boolean(JSON.parse(r.stdout).loggedIn);
    } catch {
      authenticated = r.code === 0 ? undefined : false;
    }
    if (authenticated === false) message = "Not signed in. Run `claude auth login` in a terminal.";
  } else {
    const r = await run(exe, ["login", "status"]);
    authenticated = r.code === 0 && /logged in/i.test(r.stdout + r.stderr);
    if (!authenticated) message = "Not signed in. Run `codex login` in a terminal.";
  }
  return { id, label: LABELS[id], installed: true, version, executablePath: exe, authenticated, message };
}

export async function providerStatus(refresh = false): Promise<ProviderStatus[]> {
  if (cache && !refresh) return cache;
  await ensureShellPath();
  cache = await Promise.all((["claude", "codex"] as const).map(check));
  return cache;
}

export async function executableFor(id: AgentProviderId): Promise<string> {
  const s = (await providerStatus()).find((p) => p.id === id);
  if (!s?.executablePath) throw new Error(`${LABELS[id]} is not installed on this computer.`);
  return s.executablePath;
}
