import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { systemAppend } from "@studio/agent-kit";
import { executableFor, spawnOptionsFor } from "./detect";
import type { AgentDriver, DriverEvent, TurnOptions } from "./driver";

type Json = Record<string, unknown>;

/** Minimal JSON-RPC client for `codex app-server` (newline-delimited JSON over stdio). */
class AppServer {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(method: string, params: Json) => void>();
  private stderr = "";
  ready: Promise<void>;
  closed = false;

  constructor(exe: string, cwd: string) {
    const cmd = /\.(cmd|bat)$/i.test(exe) ? `"${exe}"` : exe;
    this.child = spawn(cmd, ["app-server"], spawnOptionsFor(exe, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env }));
    createInterface({ input: this.child.stdout! }).on("line", (line) => this.onLine(line));
    this.child.stderr!.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    this.child.on("exit", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`Codex stopped.${this.stderr ? `\n${this.stderr}` : ""}`));
      this.pending.clear();
    });
    this.ready = this.request("initialize", {
      clientInfo: { name: "studio", title: "Studio", version: "0.1.0" },
      capabilities: null,
    }).then(() => this.notify("initialized", {}));
  }

  private send(msg: Json): void {
    this.child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
      if (msg.error) p.reject(new Error((msg.error as Json).message as string));
      else p.resolve((msg.result ?? {}) as Json);
      return;
    }
    if ("id" in msg && "method" in msg) {
      // Server → client requests. Studio runs with approvals off; the one thing that may still
      // ask is a call to Studio's own MCP tools, which we accept. Everything else is declined.
      const params = (msg.params ?? {}) as Json;
      if (msg.method === "mcpServer/elicitation/request" && params.serverName === "studio") {
        this.send({ jsonrpc: "2.0", id: msg.id, result: { action: "accept", content: elicitationDefaults(params.requestedSchema), _meta: null } });
      } else {
        this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Not supported by Studio" } });
      }
      return;
    }
    if ("method" in msg) for (const fn of this.listeners) fn(msg.method as string, (msg.params ?? {}) as Json);
  }

  kill(): void {
    this.closed = true;
    this.child.kill();
  }
}

const servers = new Map<string, AppServer>();

async function serverFor(projectId: string, dir: string): Promise<AppServer> {
  let s = servers.get(projectId);
  if (!s || s.closed) {
    s = new AppServer(await executableFor("codex"), dir);
    servers.set(projectId, s);
  }
  await s.ready;
  return s;
}

export const codexDriver: AgentDriver = {
  async runTurn(opts: TurnOptions, emit: (e: DriverEvent) => void) {
    const server = await serverFor(opts.projectId, opts.dir);
    const threadConfig = {
      cwd: opts.dir,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      developerInstructions: systemAppend(opts.kind),
      config: {
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
      } catch {
        threadId = undefined;
      }
    }
    if (!threadId) {
      const res = await server.request("thread/start", threadConfig);
      threadId = (res.thread as Json).id as string;
    }

    let turnId: string | undefined;
    let lastMessageItem: string | undefined;
    const done = new Promise<void>((resolve, reject) => {
      const off = server.on((method, p) => {
        if (p.threadId && p.threadId !== threadId) return;
        switch (method) {
          case "item/agentMessage/delta":
            if (lastMessageItem && lastMessageItem !== p.itemId) emit({ type: "text", delta: "\n\n" });
            lastMessageItem = p.itemId as string;
            emit({ type: "text", delta: String(p.delta ?? "") });
            break;
          case "item/started": {
            const item = p.item as Json;
            const ev = toolEvent(item);
            if (ev) emit({ type: "tool.start", ...ev });
            break;
          }
          case "item/completed": {
            const item = p.item as Json;
            if (toolEvent(item)) emit({ type: "tool.end", id: item.id as string, ok: !/fail|error|declin/i.test(String(item.status ?? "")) });
            break;
          }
          case "error":
            if (!p.willRetry) {
              off();
              reject(new Error(((p.error as Json)?.message as string) ?? "Codex reported an error"));
            }
            break;
          case "turn/completed": {
            off();
            const turn = p.turn as Json;
            const err = turn?.error as Json | undefined;
            if (err && !opts.signal.aborted) reject(new Error((err.message as string) ?? "Turn failed"));
            else resolve();
            break;
          }
        }
      });
      if (server.closed) {
        off();
        reject(new Error("Codex stopped unexpectedly."));
      }
    });

    const started = await server.request("turn/start", {
      threadId,
      input: [{ type: "text", text: opts.prompt, text_elements: [] }],
    });
    turnId = ((started.turn as Json)?.id as string) ?? undefined;
    const onAbort = () => {
      if (turnId) void server.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await done;
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }
    return { sessionId: threadId };
  },

  dispose(projectId: string) {
    servers.get(projectId)?.kill();
    servers.delete(projectId);
  },
};

/** Fill an elicitation form with its defaults, choosing "for this session" where offered. */
function elicitationDefaults(schema: unknown): Json {
  const props = ((schema as Json | undefined)?.properties ?? {}) as Record<string, Json>;
  const out: Json = {};
  for (const [key, field] of Object.entries(props)) {
    const options = (field.enum as string[] | undefined) ?? ((field.oneOf as Json[] | undefined)?.map((o) => o.const as string));
    const session = options?.find((o) => /session/i.test(o));
    if (session) out[key] = session;
    else if (field.default !== undefined) out[key] = field.default;
    else if (field.type === "boolean") out[key] = true;
  }
  return out;
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
