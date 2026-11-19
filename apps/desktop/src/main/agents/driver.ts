import type { AgentSettings, ProjectKind } from "@studio/shared";
import type { Approver } from "./approvals";

export interface TurnOptions {
  projectId: string;
  dir: string;
  kind: ProjectKind;
  prompt: string;
  /** Provider session / thread id to continue, if any. */
  sessionId?: string;
  /** Studio MCP endpoint for this project. */
  mcpUrl: string;
  /** Read-only folders the agent may look at (library type declarations). */
  readOnlyDirs: string[];
  signal: AbortSignal;
  /** Model, reasoning effort, fast mode and access level chosen in the chat bar. */
  settings: AgentSettings;
  /** Ask the teacher for permission (approval card in the chat). */
  approve: Approver;
}

/** Provider-neutral events a driver reports while a turn runs. */
export type DriverEvent =
  | { type: "text"; delta: string }
  | { type: "tool.start"; id: string; name: string; input?: Record<string, unknown> }
  | { type: "tool.end"; id: string; ok: boolean }
  /** Something the teacher should know (usage limit, retrying, fresh session). */
  | { type: "notice"; text: string };

export interface AgentDriver {
  runTurn(opts: TurnOptions, emit: (e: DriverEvent) => void): Promise<{ sessionId?: string }>;
  dispose?(projectId: string): void;
}
