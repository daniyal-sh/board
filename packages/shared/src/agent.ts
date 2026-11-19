import type { AgentProviderId } from "./project.ts";

/** Whether an agent CLI is usable on this machine. */
export interface ProviderStatus {
  id: AgentProviderId;
  label: string;
  installed: boolean;
  version?: string;
  executablePath?: string;
  /** Last known sign-in state; undefined when it has not been checked. */
  authenticated?: boolean;
  message?: string;
}

/** Something the teacher clicked in the preview, sent along with a prompt. */
export interface Selection {
  /** Stable name from the scene or page, e.g. "secant_line" or "angle_slider". */
  part: string;
  /** Human label, e.g. "Line" or "Slider". */
  kind?: string;
  /** Scene or section id. */
  sceneId?: string;
  /** Seconds into the scene (video / web animation). */
  time?: number;
  /** Source file and line when known. */
  source?: { file: string; line?: number };
}

export interface AgentRequest {
  projectId: string;
  text: string;
  sceneId?: string;
  selection?: Selection;
}

export type StepStatus = "running" | "done" | "error";

export type ApprovalKind = "command" | "web" | "file" | "other";
export type ApprovalDecision = "allow" | "always" | "deny";

export interface ApprovalRequest {
  requestId: string;
  kind: ApprovalKind;
  /** "Run a command", "Download from the web", … */
  title: string;
  /** The command, URL or path. */
  detail?: string;
  /** Why, when the assistant said. */
  reason?: string;
}

/** Streamed from main to renderer while a turn runs. */
export type AgentEvent =
  | { type: "turn.started"; projectId: string; turnId: string; text: string; selection?: Selection }
  | { type: "text"; projectId: string; turnId: string; delta: string }
  | {
      type: "step";
      projectId: string;
      turnId: string;
      stepId: string;
      label: string;
      detail?: string;
      status: StepStatus;
    }
  | { type: "notice"; projectId: string; turnId: string; text: string }
  /** The assistant wants to do something that needs the teacher's OK. */
  | { type: "approval"; projectId: string; turnId: string; request: ApprovalRequest }
  | { type: "approval.resolved"; projectId: string; turnId: string; requestId: string; decision: ApprovalDecision }
  | { type: "preview.updated"; projectId: string }
  | { type: "turn.completed"; projectId: string; turnId: string; commit?: string }
  | { type: "turn.failed"; projectId: string; turnId: string; error: string };

/** A finished turn as stored in the project's chat log. */
export interface ChatTurn {
  turnId: string;
  text: string;
  selection?: Selection;
  reply: string;
  steps: { stepId: string; label: string; detail?: string; status: StepStatus }[];
  status: "running" | "done" | "error";
  error?: string;
  commit?: string;
  startedAt: string;
  finishedAt?: string;
  /** Usage limits, retries, fresh sessions: shown as small notes under the reply. */
  notices?: string[];
  /** Things the assistant asked permission for during this turn. */
  approvals?: (ApprovalRequest & { decision?: ApprovalDecision })[];
}
