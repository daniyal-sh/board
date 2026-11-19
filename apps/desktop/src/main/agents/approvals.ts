import { randomUUID } from "node:crypto";
import type { AgentEvent, ApprovalDecision, ApprovalKind, ApprovalRequest } from "@studio/shared";

/**
 * Approval cards. A driver asks; the teacher answers in the chat; the driver's promise resolves.
 * "Always allow" is remembered for the rest of the session, per project and kind of action
 * (e.g. "run commands"), so a long task doesn't ask the same thing twenty times.
 */
interface Pending {
  projectId: string;
  turnId: string;
  request: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
}

const pending = new Map<string, Pending>();
const alwaysAllowed = new Map<string, Set<ApprovalKind>>();

export type Approver = (req: Omit<ApprovalRequest, "requestId">) => Promise<ApprovalDecision>;

/** An approver bound to one turn. */
export function makeApprover(projectId: string, turnId: string, emit: (e: AgentEvent) => void, signal: AbortSignal): Approver {
  return (req) => {
    if (alwaysAllowed.get(projectId)?.has(req.kind)) return Promise.resolve("allow");
    if (signal.aborted) return Promise.resolve("deny");
    const request: ApprovalRequest = { ...req, requestId: randomUUID() };
    return new Promise<ApprovalDecision>((resolve) => {
      pending.set(request.requestId, { projectId, turnId, request, resolve });
      emit({ type: "approval", projectId, turnId, request });
      signal.addEventListener("abort", () => respond(request.requestId, "deny", emit), { once: true });
    });
  };
}

export function respond(requestId: string, decision: ApprovalDecision, emit: (e: AgentEvent) => void): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  if (decision === "always") {
    const set = alwaysAllowed.get(p.projectId) ?? new Set<ApprovalKind>();
    set.add(p.request.kind);
    alwaysAllowed.set(p.projectId, set);
  }
  emit({ type: "approval.resolved", projectId: p.projectId, turnId: p.turnId, requestId, decision });
  p.resolve(decision);
}

/** Deny anything still open when a turn ends. */
export function denyOpen(projectId: string, turnId: string, emit: (e: AgentEvent) => void): void {
  for (const [id, p] of pending) if (p.projectId === projectId && p.turnId === turnId) respond(id, "deny", emit);
}

/** Changing the access level resets remembered "always allow" answers. */
export function resetAlways(projectId: string): void {
  alwaysAllowed.delete(projectId);
}
