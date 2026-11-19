import type { AgentSettings, ProjectKind } from "@studio/shared";

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
  /** Model, reasoning effort and fast mode chosen in the picker. */
  settings: AgentSettings;
}

/** Provider-neutral events a driver reports while a turn runs. */
export type DriverEvent =
  | { type: "text"; delta: string }
  | { type: "tool.start"; id: string; name: string; input?: Record<string, unknown> }
  | { type: "tool.end"; id: string; ok: boolean };

export interface AgentDriver {
  runTurn(opts: TurnOptions, emit: (e: DriverEvent) => void): Promise<{ sessionId?: string }>;
  dispose?(projectId: string): void;
}
