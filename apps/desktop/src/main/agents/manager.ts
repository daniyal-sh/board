import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentRequest, ChatTurn, Selection } from "@studio/shared";
import { commitAll } from "../history";
import { paths } from "../paths";
import { projects } from "../projects";
import { claudeDriver } from "./claude";
import { codexDriver } from "./codex";
import type { AgentDriver, DriverEvent } from "./driver";
import { setToolContext, toolServerUrl } from "./tools";

const drivers: Record<string, AgentDriver> = { claude: claudeDriver, codex: codexDriver };

type Emit = (e: AgentEvent) => void;

const running = new Map<string, AbortController>();

/** A teacher-friendly label for a tool call. Returns null for calls not worth showing. */
function stepLabel(name: string, input: Record<string, unknown> = {}): { label: string; detail?: string } | null {
  const file = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "";
  const short = file ? file.split(/[\\/]/).slice(-2).join("/") : "";
  if (/\.studio[\\/]guide/.test(file)) return { label: "Reading the guide", detail: basename(file) };
  switch (name) {
    case "Read":
      return { label: "Reading", detail: short };
    case "Write":
    case "Edit":
    case "MultiEdit":
      return { label: "Editing", detail: short };
    case "Glob":
    case "Grep":
      return { label: "Looking through the project" };
    case "WebSearch":
      return { label: "Searching the web", detail: String(input.query ?? "") };
    case "TodoWrite":
      return { label: "Planning" };
    case "ToolSearch":
      return null;
    case "Bash": {
      // Codex reads and lists files through the shell; teachers don't need the command line.
      const cmd = String(input.command ?? "");
      if (/Get-Content|Get-ChildItem|\bcat\b|\bls\b|\brg\b|\bgrep\b|Select-String|\bsed -n\b|\bhead\b|\btype\b/i.test(cmd)) return { label: "Looking through the project" };
      return { label: "Running a check" };
    }
    case "mcp__studio__render_preview":
      return { label: "Rendering the preview", detail: input.scene ? String(input.scene) : undefined };
    case "mcp__studio__get_frames":
      return { label: "Checking how it looks" };
    case "mcp__studio__get_console":
      return { label: "Checking for errors" };
    case "mcp__studio__get_selection":
      return { label: "Looking at your selection" };
    default:
      // Provider-internal tools (e.g. Codex's code runner) get a neutral label.
      return { label: "Working it out" };
  }
}

function describeSelection(s: Selection): string {
  const bits = [`part "${s.part}"`];
  if (s.kind) bits.push(`(${s.kind})`);
  if (s.sceneId) bits.push(`in scene ${s.sceneId}`);
  if (s.time !== undefined) bits.push(`at ${s.time.toFixed(1)} s`);
  if (s.source) bits.push(`defined at ${s.source.file}${s.source.line ? `:${s.source.line}` : ""}`);
  return `[The teacher has selected ${bits.join(" ")}. Apply the request to that part.]`;
}

function summarize(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 72 ? `${t.slice(0, 69)}…` : t;
}

export async function sendToAgent(req: AgentRequest, emit: Emit): Promise<{ turnId: string }> {
  if (running.has(req.projectId)) throw new Error("The assistant is still working on the previous request.");
  const manifest = projects.manifest(req.projectId);
  const dir = projects.dir(req.projectId);
  const provider = manifest.agent.provider;
  const driver = drivers[provider];
  const turnId = randomUUID();
  const abort = new AbortController();
  running.set(req.projectId, abort);

  const chat = projects.chat(req.projectId);
  const turn: ChatTurn = {
    turnId,
    text: req.text,
    selection: req.selection,
    reply: "",
    steps: [],
    status: "running",
    startedAt: new Date().toISOString(),
  };
  chat.push(turn);
  projects.saveChat(req.projectId, chat);
  emit({ type: "turn.started", projectId: req.projectId, turnId, text: req.text, selection: req.selection });

  setToolContext(req.projectId, {
    selection: req.selection,
    onPreviewUpdated: () => emit({ type: "preview.updated", projectId: req.projectId }),
    onStep: () => {},
  });

  const prompt = [
    req.selection ? describeSelection(req.selection) : "",
    req.sceneId && !req.selection ? `[The teacher is looking at scene "${req.sceneId}".]` : "",
    req.text,
  ]
    .filter(Boolean)
    .join("\n");

  const stepFor = new Map<string, string>();
  const onEvent = (e: DriverEvent) => {
    if (e.type === "text") {
      turn.reply += e.delta;
      emit({ type: "text", projectId: req.projectId, turnId, delta: e.delta });
    } else if (e.type === "tool.start") {
      const s = stepLabel(e.name, e.input);
      if (!s) return;
      const stepId = e.id;
      stepFor.set(e.id, stepId);
      turn.steps.push({ stepId, label: s.label, detail: s.detail, status: "running" });
      emit({ type: "step", projectId: req.projectId, turnId, stepId, label: s.label, detail: s.detail, status: "running" });
    } else if (e.type === "tool.end") {
      const stepId = stepFor.get(e.id);
      const step = turn.steps.find((s) => s.stepId === stepId);
      if (!step) return;
      step.status = e.ok ? "done" : "error";
      emit({ type: "step", projectId: req.projectId, turnId, stepId: step.stepId, label: step.label, detail: step.detail, status: step.status });
    }
  };

  void (async () => {
    const session = projects.session(req.projectId);
    try {
      const result = await driver.runTurn(
        {
          projectId: req.projectId,
          dir,
          kind: manifest.kind,
          prompt,
          sessionId: session[provider],
          mcpUrl: toolServerUrl(req.projectId),
          readOnlyDirs: [join(paths.labKitDir, "node_modules"), join(paths.labKitDir, "src")],
          signal: abort.signal,
        },
        onEvent,
      );
      if (result.sessionId) projects.saveSession(req.projectId, { ...session, [provider]: result.sessionId });
      projects.adoptContentTitle(req.projectId);
      const commit = await commitAll(dir, `Turn: ${summarize(req.text)}`);
      turn.status = "done";
      turn.commit = commit ?? undefined;
      for (const s of turn.steps) if (s.status === "running") s.status = "done";
      projects.touch(req.projectId);
      emit({ type: "turn.completed", projectId: req.projectId, turnId, commit: commit ?? undefined });
    } catch (err) {
      const message = abort.signal.aborted ? "Stopped." : err instanceof Error ? err.message : String(err);
      turn.status = "error";
      turn.error = message;
      // Keep partial work as a version so it can still be undone.
      await commitAll(dir, `Turn (stopped): ${summarize(req.text)}`).catch(() => null);
      emit({ type: "turn.failed", projectId: req.projectId, turnId, error: message });
    } finally {
      running.delete(req.projectId);
      const all = projects.chat(req.projectId);
      const i = all.findIndex((t) => t.turnId === turnId);
      if (i >= 0) all[i] = turn;
      projects.saveChat(req.projectId, all);
    }
  })();

  return { turnId };
}

export function interruptAgent(projectId: string): void {
  running.get(projectId)?.abort();
}

export function isRunning(projectId: string): boolean {
  return running.has(projectId);
}
