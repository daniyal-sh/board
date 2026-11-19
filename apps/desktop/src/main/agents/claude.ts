import { isAbsolute, relative, resolve } from "node:path";
import { query, type CanUseTool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { systemAppend } from "@studio/agent-kit";
import { executableFor } from "./detect";
import type { AgentDriver, DriverEvent, TurnOptions } from "./driver";

/** Built-in Claude Code tools a Studio agent may use. No shell. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "NotebookEdit"]);
const OTHER_TOOLS = new Set(["TodoWrite", "WebSearch"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function inside(dir: string, p: string): boolean {
  const rel = relative(dir, isAbsolute(p) ? p : resolve(dir, p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const v = input.file_path ?? input.path ?? input.notebook_path;
  return typeof v === "string" ? v : undefined;
}

/**
 * Claude Code through the Claude Agent SDK, running the user's installed `claude`
 * binary so it uses their own sign-in (the same approach t3code takes).
 */
export const claudeDriver: AgentDriver = {
  async runTurn(opts: TurnOptions, emit: (e: DriverEvent) => void) {
    const exe = await executableFor("claude");
    const abort = new AbortController();
    opts.signal.addEventListener("abort", () => abort.abort(), { once: true });

    const canUseTool: CanUseTool = async (toolName, input) => {
      if (toolName.startsWith("mcp__studio__") || OTHER_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
      if (FILE_TOOLS.has(toolName)) {
        const p = pathOf(input);
        const readOnly = !WRITE_TOOLS.has(toolName);
        const ok = !p || inside(opts.dir, p) || (readOnly && opts.readOnlyDirs.some((d) => inside(d, p)));
        if (ok && p && WRITE_TOOLS.has(toolName) && inside(resolve(opts.dir, ".studio"), resolve(opts.dir, p))) {
          return { behavior: "deny", message: "The .studio folder is managed by the app. Edit project files instead." };
        }
        return ok
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "Only files inside the project folder can be changed." };
      }
      return { behavior: "deny", message: `${toolName} is not available in Studio. Use the Studio tools (render_preview, get_frames, get_console).` };
    };

    const q = query({
      prompt: opts.prompt,
      options: {
        pathToClaudeCodeExecutable: exe,
        cwd: opts.dir,
        // Video renders can take minutes; give Studio tools room.
        env: { ...process.env, MCP_TOOL_TIMEOUT: "900000" },
        additionalDirectories: opts.readOnlyDirs,
        resume: opts.sessionId,
        abortController: abort,
        includePartialMessages: true,
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend(opts.kind) },
        mcpServers: { studio: { type: "http", url: opts.mcpUrl } },
        allowedTools: ["Read", "Glob", "Grep", "TodoWrite", "mcp__studio__render_preview", "mcp__studio__get_console", "mcp__studio__get_frames", "mcp__studio__get_selection"],
        disallowedTools: ["Bash", "BashOutput", "KillShell", "WebFetch", "Task", "Agent"],
        permissionMode: "default",
        canUseTool,
      },
    });

    let sessionId = opts.sessionId;
    let failure: string | undefined;
    let newMessage = false;
    let wroteText = false;
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if ("session_id" in msg && msg.session_id) sessionId = msg.session_id;
      switch (msg.type) {
        case "stream_event": {
          if (msg.parent_tool_use_id) break;
          const ev = msg.event as { type: string; delta?: { type: string; text?: string } };
          if (ev.type === "message_start") newMessage = true;
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            // Separate text from consecutive assistant messages with a paragraph break.
            if (newMessage && wroteText) emit({ type: "text", delta: "\n\n" });
            newMessage = false;
            wroteText = true;
            emit({ type: "text", delta: ev.delta.text });
          }
          break;
        }
        case "assistant": {
          if (msg.parent_tool_use_id) break;
          for (const block of msg.message.content as { type: string; id?: string; name?: string; input?: unknown }[]) {
            if (block.type === "tool_use" && block.id && block.name) {
              emit({ type: "tool.start", id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
            }
          }
          break;
        }
        case "user": {
          const content = (msg.message as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const block of content as { type: string; tool_use_id?: string; is_error?: boolean }[]) {
              if (block.type === "tool_result" && block.tool_use_id) emit({ type: "tool.end", id: block.tool_use_id, ok: !block.is_error });
            }
          }
          break;
        }
        case "result": {
          if (msg.subtype !== "success" || msg.is_error) {
            const r = msg as { result?: string; errors?: string[]; subtype: string };
            failure = r.result || r.errors?.join("\n") || r.subtype;
          }
          break;
        }
        default:
          break;
      }
    }
    if (failure && !opts.signal.aborted) throw new Error(failure);
    return { sessionId };
  },
};
