import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { dirname, join } from "node:path";

/**
 * Process plumbing shared by the Claude and Codex integrations (patterned on t3code's).
 *
 * - The environment drops variables that make a child misbehave: a Claude Code session that
 *   launched Studio exports CLAUDECODE & co., and a CLI spawned with them acts as part of that
 *   session; ELECTRON_RUN_AS_NODE would make any Electron app the agent starts run as plain Node.
 * - On Windows, npm installs CLIs as .cmd shims. Spawning those needs cmd.exe, which can't be
 *   stopped reliably (killing cmd.exe orphans node and the native binary), so shims are resolved
 *   to the real executable where possible, and process trees are killed with taskkill /T.
 */

const isWin = process.platform === "win32";

/** Variables a parent Claude Code session exports; a claude spawned with them joins that session. */
const CLAUDE_HOST_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
  "CLAUDE_AGENT_SDK_VERSION",
];

export function providerEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CLAUDE_HOST_SESSION_VARIABLES) delete env[name];
  delete env.ELECTRON_RUN_AS_NODE;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * The native Codex binary behind npm's codex.cmd shim (codex.cmd → node codex.js → codex.exe),
 * so the app-server can be spawned (and stopped) directly.
 */
export function resolveCodexNative(exe: string): string | undefined {
  if (!isWin || !/\.cmd$/i.test(exe)) return undefined;
  const shim = (() => {
    try {
      return fs.readFileSync(exe, "utf8");
    } catch {
      return "";
    }
  })();
  const js = /"%dp0%\\([^"]*codex\.js)"/i.exec(shim)?.[1];
  if (!js) return undefined;
  const pkgDir = join(dirname(exe), dirname(js), "..");
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const pkg = `codex-win32-${process.arch}`;
  const candidates = [
    join(pkgDir, "node_modules", "@openai", pkg, "vendor", `${arch}-pc-windows-msvc`, "bin", "codex.exe"),
    join(pkgDir, "node_modules", "@openai", pkg, "vendor", `${arch}-pc-windows-msvc`, "codex", "codex.exe"),
    join(pkgDir, "vendor", `${arch}-pc-windows-msvc`, "codex", "codex.exe"),
    join(pkgDir, "..", pkg, "vendor", `${arch}-pc-windows-msvc`, "bin", "codex.exe"),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

const WINDOWS_SHELL_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quote an argument for both cmd.exe and CommandLineToArgvW (same rules t3code uses). */
function escapeWindowsShellArg(arg: string): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`.replace(WINDOWS_SHELL_META, "^$1");
}

/**
 * Spawn a CLI. Native executables run directly; Windows .cmd/.bat shims go through cmd.exe with a
 * fully escaped command line (no separate args, which Node deprecates with shell: true).
 */
export function spawnCli(exe: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (isWin && /\.(cmd|bat)$/i.test(exe)) {
    const line = [exe, ...args].map(escapeWindowsShellArg).join(" ");
    return spawn(line, [], { ...options, shell: true, windowsHide: true });
  }
  return spawn(exe, args, { ...options, windowsHide: true });
}

/** Stop a process and everything it started (Windows doesn't do this by itself). */
export function killTree(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return;
  if (isWin) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000).unref();
    } catch {
      /* already gone */
    }
  }
}

/** Keep the end of a stream (stderr), so failures can be explained. */
export function tail(max = 2048) {
  let text = "";
  return {
    push: (chunk: string | Buffer) => {
      text = (text + chunk.toString()).slice(-max);
    },
    get value() {
      return text.trim();
    },
  };
}

/** Human "3h 12m" from milliseconds. */
export function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}
