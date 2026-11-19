import { isAbsolute, relative, resolve } from "node:path";
import { query, type CanUseTool, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { systemAppend } from "@studio/agent-kit";
import { executableFor } from "./detect";
import type { AgentDriver, DriverEvent, TurnOptions } from "./driver";
import { formatWait, providerEnv, tail } from "./process";

/** Tool groups for the access policy below. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "NotebookEdit"]);
const OTHER_TOOLS = new Set(["TodoWrite", "WebSearch", "ToolSearch"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Claude Code's answer to a --resume whose session is gone (as a result error and on stderr). */
const CONVERSATION_NOT_FOUND = "No conversation found with session ID";
/** How long Stop waits for a graceful interrupt before killing the CLI. */
const STOP_GRACE_MS = 8000;

function inside(dir: string, p: string): boolean {
  const rel = relative(dir, isAbsolute(p) ? p : resolve(dir, p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const v = input.file_path ?? input.path ?? input.notebook_path;
  return typeof v === "string" ? v : undefined;
}

/** Turn a failed result into one sentence a teacher can act on (mirrors t3code's mapping). */
function resultError(r: SDKResultMessage, limitNotice?: string): string | undefined {
  const reason = (r as { terminal_reason?: string }).terminal_reason;
  const status = (r as { api_error_status?: number }).api_error_status;
  if (reason === "aborted_tools" || reason === "aborted_streaming") return "Stopped.";
  const text = r.subtype === "success" ? r.result ?? "" : (r.errors ?? []).filter((e) => !e.startsWith("[ede_diagnostic]")).join("\n");
  if (text.includes(CONVERSATION_NOT_FOUND)) return CONVERSATION_NOT_FOUND;
  if (/invalid api key|please run \/login|authentication_error|not logged in|oauth token/i.test(text)) {
    return "Claude Code isn't signed in. Open a terminal, run `claude auth login`, then try again.";
  }
  if (status === 429 || (limitNotice && r.is_error)) return limitNotice ?? "Claude's usage limit was reached. Try again later, or switch to a smaller model.";
  if (status === 529) return "Claude is overloaded right now. Try again in a minute.";
  switch (reason) {
    case "prompt_too_long":
    case "blocking_limit":
      return "The conversation got too long for the model. Start a fresh request; the project files keep all the work.";
    case "budget_exhausted":
      return "Claude ran out of its budget for this request. Try a smaller request.";
    case "malformed_tool_use_exhausted":
      return "Claude got stuck calling its tools. Try again, or rephrase the request.";
    case "api_error":
      return "Claude gave up after repeated API errors. Check your connection and try again.";
    case "model_error":
      return "The model returned an error. Try again, or pick another model.";
    case "turn_setup_failed":
      return "Claude couldn't start the request. Try again.";
  }
  if (r.subtype === "success" && !r.is_error) return undefined;
  if (MODEL_PROBLEM.test(text)) return MODEL_MESSAGE;
  if (r.subtype === "error_max_turns") return "Claude hit its step limit for one request. Ask it to continue.";
  return text.split("\n")[0]?.slice(0, 300) || "Claude stopped with an error.";
}

const MODEL_PROBLEM = /issue with the selected model|unrecognized_model|model.*(not found|not available|invalid|may not exist)|unknown model/i;
const MODEL_MESSAGE = "That model isn't available on your account. Pick another one in the model menu.";

/** Why fast mode didn't engage, when the teacher asked for it. */
const FAST_UNAVAILABLE: Record<string, string> = {
  extra_usage_disabled: "Fast mode is off: it uses extra usage, which isn't enabled for your Claude account. Turn it on in your Claude account settings to use fast mode.",
  free: "Fast mode isn't included in your Claude plan.",
  model_not_allowed: "Fast mode isn't available for this model. Pick a model marked ⚡.",
  not_first_party: "Fast mode isn't available with this Claude setup.",
  disabled_by_env: "Fast mode is turned off on this computer (CLAUDE_CODE_DISABLE_FAST_MODE).",
  preference: "Fast mode is turned off by your organization's Claude settings.",
};

type RateLimitInfo = { status?: string; resetsAt?: number; rateLimitType?: string; overageStatus?: string; isUsingOverage?: boolean };

/** Friendly notice for a rejected rate-limit event (Claude subscription usage windows). */
function limitNotice(info: RateLimitInfo): string | undefined {
  const overage = info.overageStatus === "allowed" || info.overageStatus === "allowed_warning" || info.isUsingOverage;
  if (info.status !== "rejected" || overage) return undefined;
  const window = info.rateLimitType === "five_hour" ? "5-hour " : info.rateLimitType?.startsWith("seven_day") ? "weekly " : "";
  const wait = info.resetsAt ? info.resetsAt * 1000 - Date.now() : NaN;
  return `Claude usage limit reached. Your ${window}limit resets${Number.isFinite(wait) && wait > 0 ? ` in ${formatWait(wait)}` : " soon"}.`;
}

/**
 * Claude Code through the Claude Agent SDK, running the user's installed `claude` binary so it
 * uses their own sign-in (the same approach t3code takes).
 */
export const claudeDriver: AgentDriver = {
  async runTurn(opts: TurnOptions, emit: (e: DriverEvent) => void) {
    try {
      return await runOnce(opts, emit, opts.sessionId);
    } catch (e) {
      // The saved session is gone (history cleared, other computer): continue in a new one.
      if (opts.sessionId && e instanceof Error && e.message === CONVERSATION_NOT_FOUND && !opts.signal.aborted) {
        emit({ type: "notice", text: "Started a fresh Claude session (the previous one wasn't found). The project files keep all the work." });
        return runOnce(opts, emit, undefined);
      }
      throw e;
    }
  },
};

async function runOnce(opts: TurnOptions, emit: (e: DriverEvent) => void, resume: string | undefined): Promise<{ sessionId?: string }> {
  const exe = await executableFor("claude");
  const abort = new AbortController();
  const stderr = tail();

  const access = opts.settings.access ?? "ask";
  const askFirst = async (kind: "command" | "web" | "file" | "other", title: string, detail: string | undefined, input: Record<string, unknown>, reason?: string) => {
    const d = await opts.approve({ kind, title, detail, reason });
    return d === "deny"
      ? ({ behavior: "deny", message: "The teacher declined this. Continue without it if you can, or explain briefly what you need and why." } as const)
      : ({ behavior: "allow", updatedInput: input } as const);
  };

  /**
   * Access levels (the chat bar's access menu):
   *  ask  - project files freely; commands, web pages and files elsewhere show an approval card
   *  auto - also commands and the web without asking; changing files outside the project still asks
   *  full - bypassPermissions, no checks (canUseTool isn't consulted)
   */
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName.startsWith("mcp__studio__") || OTHER_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
    if (FILE_TOOLS.has(toolName)) {
      const p = pathOf(input);
      const readOnly = !WRITE_TOOLS.has(toolName);
      if (p && !readOnly && inside(resolve(opts.dir, ".studio"), resolve(opts.dir, p))) {
        return { behavior: "deny", message: "The .studio folder is managed by the app. Edit project files instead." };
      }
      if (!p || readOnly || inside(opts.dir, p)) return { behavior: "allow", updatedInput: input };
      return askFirst("file", "Change a file outside the project", p, input);
    }
    if (toolName === "Bash" || toolName === "PowerShell") {
      if (access === "auto") return { behavior: "allow", updatedInput: input };
      return askFirst("command", "Run a command", String(input.command ?? ""), input, typeof input.description === "string" ? input.description : undefined);
    }
    if (toolName === "BashOutput" || toolName === "KillShell" || toolName === "KillBash") return { behavior: "allow", updatedInput: input };
    if (toolName === "WebFetch") {
      if (access === "auto") return { behavior: "allow", updatedInput: input };
      return askFirst("web", "Open a web page", String(input.url ?? ""), input);
    }
    if (access === "auto") return { behavior: "allow", updatedInput: input };
    return askFirst("other", `Use ${toolName}`, JSON.stringify(input).slice(0, 200), input);
  };

  const q: Query = query({
    prompt: opts.prompt,
    options: {
      pathToClaudeCodeExecutable: exe,
      cwd: opts.dir,
      additionalDirectories: opts.readOnlyDirs,
      resume,
      abortController: abort,
      includePartialMessages: true,
      settingSources: ["project"],
      ...(opts.settings.model && opts.settings.model !== "default" ? { model: opts.settings.model } : {}),
      ...(opts.settings.effort ? { effort: opts.settings.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
      settings: { fastMode: Boolean(opts.settings.fast) },
      env: providerEnv({
        CLAUDE_CODE_ENTRYPOINT: "studio",
        // Video renders can take minutes; give Studio tools room.
        MCP_TOOL_TIMEOUT: "900000",
        // A resumed session's first request otherwise goes out before the Studio tools connect.
        ...(resume ? { MCP_CONNECTION_NONBLOCKING: "0" } : {}),
      }),
      stderr: (d) => stderr.push(d),
      systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend(opts.kind) },
      mcpServers: { studio: { type: "http", url: opts.mcpUrl } },
      allowedTools: ["Read", "Glob", "Grep", "TodoWrite", "mcp__studio__render_preview", "mcp__studio__get_console", "mcp__studio__get_frames", "mcp__studio__get_selection"],
      ...(access === "full"
        ? { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true }
        : { permissionMode: "default" as const, canUseTool }),
    },
  });

  // Stop: ask Claude to interrupt (keeps the session consistent), then kill it if it doesn't stop.
  let stopTimer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    q.interrupt().catch(() => abort.abort());
    stopTimer = setTimeout(() => abort.abort(), STOP_GRACE_MS);
  };
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener("abort", onAbort, { once: true });

  let sessionId = resume;
  let failure: string | undefined;
  let notice: string | undefined;
  let newMessage = false;
  let wroteText = false;
  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if ("session_id" in msg && msg.session_id) sessionId = msg.session_id;
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init" && process.env.STUDIO_DEBUG) {
            console.log(`[claude] model=${(msg as { model?: string }).model} effort=${opts.settings.effort ?? "auto"} fast=${Boolean(opts.settings.fast)}`);
          }
          break;
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
        case "rate_limit_event": {
          const n = limitNotice((msg as { rate_limit_info?: RateLimitInfo }).rate_limit_info ?? {});
          if (n && n !== notice) {
            notice = n;
            emit({ type: "notice", text: n });
          }
          break;
        }
        case "result": {
          failure = resultError(msg, notice);
          const fastState = (msg as { fast_mode_state?: string; fast_mode_disabled_reason?: string });
          const why = fastState.fast_mode_disabled_reason && FAST_UNAVAILABLE[fastState.fast_mode_disabled_reason];
          if (opts.settings.fast && fastState.fast_mode_state !== "on" && why) emit({ type: "notice", text: why });
          break;
        }
        default:
          break;
      }
    }
  } catch (e) {
    if (opts.signal.aborted) failure = "Stopped.";
    else {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes(CONVERSATION_NOT_FOUND) || stderr.value.includes(CONVERSATION_NOT_FOUND)) failure = CONVERSATION_NOT_FOUND;
      else {
        // "error_result": Claude returned a failed result; the reason follows in the message.
        const errorClass = (e as { errorClass?: string }).errorClass;
        const resultText = /returned an error result:\s*([\s\S]*)/.exec(message)?.[1]?.trim();
        // The SDK's exit error appends stderr to `message`; `telemetryMessage` is the short form.
        const telemetry = (e as { telemetryMessage?: string }).telemetryMessage;
        if (MODEL_PROBLEM.test(message) || MODEL_PROBLEM.test(stderr.value)) failure = MODEL_MESSAGE;
        else if (/invalid api key|please run \/login|authentication_error|not logged in/i.test(message + stderr.value)) {
          failure = "Claude Code isn't signed in. Open a terminal, run `claude auth login`, then try again.";
        } else if (errorClass === "error_result" && resultText) failure = resultText.split("\n")[0].slice(0, 300);
        else if (telemetry) failure = `Claude Code exited unexpectedly (${telemetry}).`;
        else if (/ENOENT|EACCES|spawn/i.test(message)) failure = "Claude Code couldn't be started. Check that it's installed (Settings).";
        else failure = message.split("\n")[0].slice(0, 300);
      }
    }
  } finally {
    clearTimeout(stopTimer);
    opts.signal.removeEventListener("abort", onAbort);
  }
  if (opts.signal.aborted) throw new Error("Stopped.");
  if (failure) throw new Error(failure);
  return { sessionId };
}
