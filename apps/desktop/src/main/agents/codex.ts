import type { ChildProcess } from "node:child_process";
import os from "node:os";
import { createInterface } from "node:readline";
import { DEFAULT_ACCESS, type ModelOption } from "@studio/shared";
import { systemAppend } from "@studio/agent-kit";
import { executableFor } from "./detect";
import type { AgentDriver, DriverEvent, TurnOptions } from "./driver";
import { killTree, providerEnv, resolveCodexNative, spawnCli, tail } from "./process";
import type { Approver } from "./approvals";

type Json = Record<string, unknown>;

/** initialize normally answers in under a second; leave room for a slow first launch. */
const INITIALIZE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;

class CodexRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * JSON-RPC client for `codex app-server` (newline-delimited JSON over stdio).
 * The native binary is spawned directly when it can be found, so it can be stopped cleanly.
 */
class AppServer {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(method: string, params: Json) => void>();
  private exitListeners = new Set<(error: Error) => void>();
  readonly stderr = tail(4000);
  ready: Promise<void>;
  closed = false;
  /** Approval cards for the turn in progress (set by runTurn). */
  approver?: Approver;

  constructor(exe: string, cwd: string) {
    const native = resolveCodexNative(exe);
    // thread_unload_delay_secs=0: Studio keeps one app-server per open project, so threads
    // don't need to linger after it closes.
    this.child = spawnCli(native ?? exe, ["app-server", "-c", "thread_unload_delay_secs=0"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: providerEnv(),
    });
    createInterface({ input: this.child.stdout! }).on("line", (line) => this.onLine(line));
    this.child.stderr!.on("data", (d) => this.stderr.push(d));
    this.child.stdin!.on("error", () => {}); // EPIPE when the process dies mid-write
    const onGone = (why: string) => {
      if (this.closed) return;
      this.closed = true;
      const err = new Error(`Codex stopped unexpectedly${why ? ` (${why})` : ""}.${this.stderr.value ? `\n${this.stderr.value.split("\n").slice(-4).join("\n")}` : ""}`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      for (const fn of this.exitListeners) fn(err);
    };
    this.child.on("exit", (code, signal) => onGone(signal ? `signal ${signal}` : code !== null ? `exit code ${code}` : ""));
    this.child.on("error", (e) => onGone(/ENOENT/.test(String(e)) ? "Codex isn't installed" : String(e)));
    this.ready = this.request("initialize", { clientInfo: { name: "apollo_board", title: "Apollo Board", version: "0.1.0" }, capabilities: null }, INITIALIZE_TIMEOUT_MS)
      .then(() => this.notify("initialized", {}))
      .catch((e: Error) => {
        this.kill();
        throw new Error(/timed out/i.test(e.message) ? "Codex didn't start in time. Try again; if it keeps happening, update Codex (npm i -g @openai/codex)." : e.message);
      });
  }

  private send(msg: Json): void {
    if (!this.closed) this.child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  request(method: string, params: Json, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Json> {
    if (this.closed) return Promise.reject(new Error("Codex isn't running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  on(fn: (method: string, params: Json) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onExit(fn: (error: Error) => void): () => void {
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  private onLine(line: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if ("id" in msg && ("result" in msg || "error" in msg) && !("method" in msg)) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      const err = msg.error as Json | undefined;
      if (err) p.reject(new CodexRequestError(Number(err.code ?? 0), String(err.message ?? "Codex request failed")));
      else p.resolve((msg.result ?? {}) as Json);
      return;
    }
    if ("id" in msg && "method" in msg) {
      this.onServerRequest(msg.id as number | string, msg.method as string, (msg.params ?? {}) as Json);
      return;
    }
    if ("method" in msg) for (const fn of this.listeners) fn(msg.method as string, (msg.params ?? {}) as Json);
  }

  /**
   * Server → client requests. Studio runs with approvals off; what may still ask is a call to
   * Studio's own MCP tools, which is accepted. Anything else is declined in the shape Codex expects.
   */
  private onServerRequest(id: number | string, method: string, params: Json): void {
    const reply = (result: Json) => this.send({ jsonrpc: "2.0", id, result });
    const ask = this.approver;
    const reason = typeof params.reason === "string" && params.reason ? params.reason : undefined;
    switch (method) {
      case "mcpServer/elicitation/request":
        if (params.serverName === "studio") reply({ action: "accept", content: elicitationDefaults(params.requestedSchema), _meta: null });
        else if (!ask) reply({ action: "decline", content: null, _meta: null });
        else
          void ask({ kind: "other", title: `Use a tool from ${String(params.serverName)}`, detail: String(params.message ?? ""), reason }).then((d) =>
            reply(d === "deny" ? { action: "decline", content: null, _meta: null } : { action: "accept", content: elicitationDefaults(params.requestedSchema), _meta: null }),
          );
        return;
      case "item/commandExecution/requestApproval": {
        if (!ask) return reply({ decision: "decline" });
        const network = Boolean(params.networkApprovalContext);
        void ask({
          kind: network ? "web" : "command",
          title: network ? "Use the internet" : "Run a command",
          detail: typeof params.command === "string" ? params.command : undefined,
          reason,
        }).then((d) => reply({ decision: d === "deny" ? "decline" : d === "always" ? "acceptForSession" : "accept" }));
        return;
      }
      case "item/fileChange/requestApproval":
        if (!ask) return reply({ decision: "decline" });
        void ask({ kind: "file", title: "Change files outside the project", detail: typeof params.grantRoot === "string" ? params.grantRoot : undefined, reason }).then((d) =>
          reply({ decision: d === "deny" ? "decline" : d === "always" ? "acceptForSession" : "accept" }),
        );
        return;
      case "item/permissions/requestApproval": {
        const requested = (params.permissions ?? {}) as Json;
        if (!ask) return reply({ permissions: {}, scope: "turn" });
        const wantsNet = Boolean(requested.network);
        void ask({ kind: wantsNet ? "web" : "file", title: wantsNet ? "Use the internet" : "Access more of this computer", reason }).then((d) => {
          const granted: Json = {};
          if (d !== "deny") for (const k of ["network", "fileSystem"]) if (requested[k]) granted[k] = requested[k];
          reply({ permissions: granted, scope: d === "always" ? "session" : "turn" });
        });
        return;
      }
      case "item/tool/requestUserInput":
        reply({ answers: {} });
        return;
      default:
        this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Apollo Board doesn't support ${method}` } });
    }
  }

  kill(): void {
    this.closed = true;
    killTree(this.child);
  }
}

/** Fill an elicitation form with its defaults, choosing "for this session" where offered. */
function elicitationDefaults(schema: unknown): Json {
  const props = ((schema as Json | undefined)?.properties ?? {}) as Record<string, Json>;
  const out: Json = {};
  for (const [key, field] of Object.entries(props)) {
    const options = (field.enum as string[] | undefined) ?? (field.oneOf as Json[] | undefined)?.map((o) => o.const as string);
    const session = options?.find((o) => /session/i.test(o));
    if (session) out[key] = session;
    else if (field.default !== undefined) out[key] = field.default;
    else if (field.type === "boolean") out[key] = true;
  }
  return out;
}

const servers = new Map<string, AppServer>();

async function serverFor(projectId: string, dir: string): Promise<AppServer> {
  let s = servers.get(projectId);
  if (!s || s.closed) {
    s = new AppServer(await executableFor("codex"), dir);
    servers.set(projectId, s);
  }
  try {
    await s.ready;
  } catch (e) {
    servers.delete(projectId);
    throw e;
  }
  return s;
}

/** One-line explanation of a Codex failure (codexErrorInfo codes, as t3code classifies them). */
function friendlyError(error: Json | undefined, fallback = "Codex stopped with an error."): string {
  if (!error) return fallback;
  const info = error.codexErrorInfo as unknown;
  const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  const details = typeof error.additionalDetails === "string" && error.additionalDetails.trim() ? error.additionalDetails.trim() : undefined;
  const message = details ?? (typeof error.message === "string" ? error.message : fallback);
  switch (code) {
    case "usageLimitExceeded":
    case "rateLimitExceeded":
      return `Codex usage limit reached. ${message}`;
    case "contextWindowExceeded":
      return "The conversation got too long for the model. Start a fresh request; the project files keep all the work.";
    case "unauthorized":
      return "Codex isn't signed in. Open a terminal, run `codex login`, then try again.";
    case "serverOverloaded":
      return "Codex is overloaded right now. Try again in a minute.";
    case "modelNotFound":
      return "That model isn't available on your account. Pick another one in the model menu.";
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
      return "Couldn't reach Codex. Check your internet connection and try again.";
    case "sandboxError":
      return "Codex's sandbox blocked an action. Try again, or rephrase the request.";
    default:
      return message.split("\n")[0].slice(0, 300);
  }
}

export const codexDriver: AgentDriver = {
  async runTurn(opts: TurnOptions, emit: (e: DriverEvent) => void) {
    const server = await serverFor(opts.projectId, opts.dir);
    // Access level → Codex's approval policy and sandbox:
    //   ask:  sandboxed to the project, no network; anything beyond asks (approval cards)
    //   auto: sandboxed to the project with network. Codex may still ask to step outside the
    //         sandbox (its Windows sandbox has no network at all); commands and web access are
    //         approved automatically, writes outside the project still show a card.
    //   full: no sandbox, never asks
    const access = opts.settings.access ?? DEFAULT_ACCESS;
    const approvalPolicy = access === "full" ? "never" : "on-request";
    const sandbox = access === "full" ? "danger-full-access" : "workspace-write";
    const sandboxPolicy =
      access === "full"
        ? { type: "dangerFullAccess" }
        : { type: "workspaceWrite", writableRoots: [], networkAccess: access === "auto", excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    server.approver = access === "auto" ? (req) => (req.kind === "command" || req.kind === "web" ? Promise.resolve("allow") : opts.approve(req)) : opts.approve;
    const threadConfig = {
      cwd: opts.dir,
      approvalPolicy,
      sandbox,
      developerInstructions: systemAppend(opts.kind),
      ...(opts.settings.model ? { model: opts.settings.model } : {}),
      config: {
        sandbox_workspace_write: { network_access: access === "auto" },
        mcp_servers: {
          // Studio's own tools: approve automatically and allow long video renders.
          studio: { url: opts.mcpUrl, default_tools_approval_mode: "approve", tool_timeout_sec: 900, startup_timeout_sec: 30 },
        },
      },
    };

    let threadId = opts.sessionId;
    if (threadId) {
      try {
        await server.request("thread/resume", { threadId, ...threadConfig, excludeTurns: true });
      } catch (e) {
        if (e instanceof CodexRequestError && e.message.includes("already has an active writer")) {
          throw new Error("This project's conversation is open in another Codex window (the Codex app, CLI or an editor). Close it there, then send again.");
        }
        // Thread gone (deleted, other computer): continue in a fresh one.
        emit({ type: "notice", text: "Started a fresh Codex conversation (the previous one wasn't found). The project files keep all the work." });
        threadId = undefined;
      }
    }
    if (!threadId) {
      const res = await server.request("thread/start", threadConfig);
      threadId = (res.thread as Json).id as string;
    }

    let turnId: string | undefined;
    let lastMessageItem: string | undefined;
    let pendingFailure: string | undefined;
    let retryShown = false;
    const done = new Promise<void>((resolve, reject) => {
      const offExit = server.onExit((err) => {
        cleanup();
        reject(err);
      });
      const off = server.on((method, p) => {
        if (p.threadId && p.threadId !== threadId) return;
        // Ignore stragglers from an earlier turn on the same thread.
        if (turnId && typeof p.turnId === "string" && p.turnId !== turnId) return;
        switch (method) {
          case "item/agentMessage/delta":
            if (lastMessageItem && lastMessageItem !== p.itemId) emit({ type: "text", delta: "\n\n" });
            lastMessageItem = p.itemId as string;
            emit({ type: "text", delta: String(p.delta ?? "") });
            break;
          case "item/started": {
            const ev = toolEvent(p.item as Json);
            if (ev) emit({ type: "tool.start", ...ev });
            break;
          }
          case "item/completed": {
            const item = p.item as Json;
            if (toolEvent(item)) emit({ type: "tool.end", id: item.id as string, ok: !/fail|error|declin/i.test(String(item.status ?? "")) });
            break;
          }
          case "error": {
            // Not the end of the turn: Codex follows with turn/completed. Retries are progress.
            const error = p.error as Json | undefined;
            if (p.willRetry) {
              if (!retryShown) {
                retryShown = true;
                emit({ type: "notice", text: `Codex hit a hiccup and is retrying: ${friendlyError(error)}` });
              }
            } else pendingFailure = friendlyError(error);
            break;
          }
          case "turn/completed": {
            const turn = p.turn as Json;
            cleanup();
            const status = turn?.status as string | undefined;
            if (status === "interrupted" || opts.signal.aborted) reject(new Error("Stopped."));
            else if (status === "failed") reject(new Error(pendingFailure ?? friendlyError(turn.error as Json | undefined)));
            else resolve();
            break;
          }
        }
      });
      const cleanup = () => {
        off();
        offExit();
      };
    });
    done.catch(() => {}); // handled below; avoid an unhandled rejection before we await it

    let started: Json;
    try {
      started = await server.request("turn/start", {
        threadId,
        input: [{ type: "text", text: opts.prompt, text_elements: [] }],
        // Model, reasoning and speed apply per turn, so the picker takes effect immediately.
        ...(opts.settings.model ? { model: opts.settings.model } : {}),
        ...(opts.settings.effort ? { effort: opts.settings.effort } : {}),
        serviceTier: opts.settings.fast ? "priority" : null,
        // Re-sent every turn so changing the access menu takes effect immediately.
        approvalPolicy,
        sandboxPolicy,
      });
    } catch (e) {
      if (e instanceof CodexRequestError && e.message.includes("already has an active writer")) {
        throw new Error("This project's conversation is open in another Codex window (the Codex app, CLI or an editor). Close it there, then send again.");
      }
      throw e;
    }
    turnId = ((started.turn as Json)?.id as string) ?? undefined;
    if (process.env.STUDIO_DEBUG) console.log(`[codex] model=${opts.settings.model ?? "default"} effort=${opts.settings.effort ?? "auto"} serviceTier=${opts.settings.fast ? "priority" : "default"}`);

    // Stop: ask Codex to interrupt; if it doesn't finish soon, restart the app-server.
    let stopTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (turnId) void server.request("turn/interrupt", { threadId, turnId }, 10_000).catch(() => {});
      stopTimer = setTimeout(() => {
        server.kill();
        servers.delete(opts.projectId);
      }, 15_000);
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await done;
    } finally {
      clearTimeout(stopTimer);
      opts.signal.removeEventListener("abort", onAbort);
    }
    return { sessionId: threadId };
  },

  dispose(projectId: string) {
    servers.get(projectId)?.kill();
    servers.delete(projectId);
  },
};

/** Stop every Codex app-server (app quitting). */
export function disposeAllCodex(): void {
  for (const s of servers.values()) s.kill();
  servers.clear();
}

/** Models the signed-in Codex account can use, with their reasoning levels and speed tiers. */
export async function listCodexModels(): Promise<ModelOption[]> {
  const server = new AppServer(await executableFor("codex"), os.homedir());
  try {
    await server.ready;
    const out: ModelOption[] = [];
    let cursor: string | null = null;
    do {
      const res = await server.request("model/list", { cursor, limit: 100 });
      for (const m of (res.data as Json[]) ?? []) {
        if (m.hidden) continue;
        const tiers = (m.serviceTiers as Json[] | undefined) ?? [];
        const fast = tiers.find((t) => t.id === "priority");
        out.push({
          id: m.id as string,
          label: m.displayName as string,
          description: (m.description as string) || undefined,
          efforts: ((m.supportedReasoningEfforts as Json[]) ?? []).map((e) => e.reasoningEffort as string),
          defaultEffort: (m.defaultReasoningEffort as string) ?? undefined,
          fast: fast ? { label: (fast.name as string) ?? "Fast", description: (fast.description as string) ?? undefined } : undefined,
        });
      }
      cursor = (res.nextCursor as string | null) ?? null;
    } while (cursor);
    return out;
  } finally {
    server.kill();
  }
}

/** Map Codex items to the generic tool events Studio shows as steps. */
function toolEvent(item: Json): { id: string; name: string; input?: Record<string, unknown> } | undefined {
  const id = item.id as string;
  switch (item.type) {
    case "mcpToolCall":
      return { id, name: `mcp__${item.server}__${item.tool}`, input: (item.arguments ?? {}) as Record<string, unknown> };
    case "fileChange": {
      const changes = (item.changes as Json[] | undefined) ?? [];
      return { id, name: "Edit", input: { file_path: changes.map((c) => c.path).join(", ") } };
    }
    case "commandExecution":
      return { id, name: "Bash", input: { command: item.command } };
    case "webSearch":
      return { id, name: "WebSearch", input: { query: item.query } };
    default:
      return undefined;
  }
}
