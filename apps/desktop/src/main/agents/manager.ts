import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentRequest, ChatTurn, ProjectKind, Selection } from "@studio/shared";
import { commitAll } from "../history";
import { paths } from "../paths";
import { projects } from "../projects";
import { claudeDriver } from "./claude";
import { codexDriver } from "./codex";
import type { AgentDriver, DriverEvent } from "./driver";
import { setToolContext, toolServerUrl } from "./tools";
import { denyOpen, makeApprover, makeAsker, skipOpenQuestions } from "./approvals";

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
    case "WebFetch":
      return { label: "Reading a web page", detail: String(input.url ?? "") };
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
      return { label: "Running a command", detail: cmd.replace(/\s+/g, " ").slice(0, 90) };
    }
    case "mcp__studio__render_preview":
      return { label: "Rendering the preview", detail: input.scene ? String(input.scene) : undefined };
    case "mcp__studio__get_frames":
      return { label: "Checking how it looks" };
    case "mcp__studio__get_console":
      return { label: "Checking for errors" };
    case "mcp__studio__get_selection":
      return { label: "Looking at your selection" };
    case "mcp__studio__get_keyframes":
      return { label: "Reviewing every step", detail: input.scene ? String(input.scene) : undefined };
    case "mcp__studio__interact":
      return { label: "Trying it like a student", detail: Array.isArray(input.actions) && input.actions.length ? `${input.actions.length} action${input.actions.length === 1 ? "" : "s"}` : undefined };
    case "mcp__studio__get_view":
      return { label: "Looking at what you see" };
    case "mcp__studio__ask_teacher":
      return null; // the questions show as a card
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

  // Questions from the assistant: recorded on the turn and shown as a card in the chat.
  const ask = makeAsker(
    req.projectId,
    turnId,
    (e) => {
      if (e.type === "question") turn.questions = [...(turn.questions ?? []), e.request];
      if (e.type === "question.resolved")
        turn.questions = (turn.questions ?? []).map((q) => (q.requestId === e.requestId ? { ...q, resolved: true, answers: e.answers } : q));
      projects.saveChat(req.projectId, chat);
      emit(e);
    },
    abort.signal,
  );

  setToolContext(req.projectId, {
    selection: req.selection,
    ask,
    onPreviewUpdated: () => emit({ type: "preview.updated", projectId: req.projectId }),
    onStep: () => {},
  });

  const prompt = [
    introInstructions(req.intro, projects.manifest(req.projectId).kind),
    req.selection ? describeSelection(req.selection) : "",
    req.sceneId && !req.selection ? `[The teacher is looking at scene "${req.sceneId}".]` : "",
    req.text,
  ]
    .filter(Boolean)
    .join("\n");

  // Approval cards: recorded on the turn (so they survive reloads) and forwarded to the UI.
  const approve = makeApprover(
    req.projectId,
    turnId,
    (e) => {
      if (e.type === "approval") turn.approvals = [...(turn.approvals ?? []), e.request];
      if (e.type === "approval.resolved") turn.approvals = (turn.approvals ?? []).map((a) => (a.requestId === e.requestId ? { ...a, decision: e.decision } : a));
      emit(e);
    },
    abort.signal,
  );

  const stepFor = new Map<string, string>();
  const onEvent = (e: DriverEvent) => {
    if (e.type === "notice") {
      turn.notices = [...(turn.notices ?? []).filter((n) => n !== e.text), e.text];
      emit({ type: "notice", projectId: req.projectId, turnId, text: e.text });
    } else if (e.type === "text") {
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
          settings: manifest.agent,
          approve,
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
      turn.finishedAt = new Date().toISOString();
      running.delete(req.projectId);
      denyOpen(req.projectId, turnId, emit);
      skipOpenQuestions(req.projectId, turnId, emit);
      const all = projects.chat(req.projectId);
      const i = all.findIndex((t) => t.turnId === turnId);
      if (i >= 0) all[i] = turn;
      projects.saveChat(req.projectId, all);
    }
  })();

  return { turnId };
}

/** Stop every running turn (app quitting). */
export function stopAllAgents(): void {
  for (const a of running.values()) a.abort();
}

export function interruptAgent(projectId: string): void {
  running.get(projectId)?.abort();
}

export function isRunning(projectId: string): boolean {
  return running.has(projectId);
}

/** Extra instructions for a project's first message (guided start, starting from a script). */
function introInstructions(intro: AgentRequest["intro"], kind: ProjectKind): string {
  if (!intro) return "";
  const parts: string[] = [];
  if (intro.guided) {
    parts.push(
      "[Guided start: before building anything, call the ask_teacher tool once with 2-4 short questions that would change what you make " +
        "(for example the class level, what students should take away, the style or tone, and pacing). Give concrete options tailored to this topic, " +
        "skip anything the request already answers, then build using the answers.]",
    );
  }
  if (intro.script && kind !== "lab") {
    const wait = kind === "video" ? 'self.wait_until("name")' : 'await scene.waitUntil("name")';
    if (kind === "slides") {
      parts.push(
        "[Start from a script: the teacher's message below is what they will say. Split it into slides at natural breaks. Put what they will say for " +
          "each slide in notes/<slide>.md (keeping their wording), and build each slide so it shows the ideas as they are spoken, step by step.]",
      );
      return parts.join("\n");
    }
    parts.push(
      "[Start from a script: the teacher's message below is the narration. Split it into scenes at natural breaks. For each scene, save its words in " +
        "narration/<scene>.md, keeping the teacher's wording (fix only obvious typos), and put {{mark:name}} cues before the words where something " +
        `should appear. Build each scene so the visuals follow the words, using ${wait} at those cues. Don't generate audio: Board voices the scripts when you finish.]`,
    );
  }
  return parts.join("\n");
}
