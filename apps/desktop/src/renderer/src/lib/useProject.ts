import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, ChatTurn, OpenProject, Selection } from "@studio/shared";
import { errorMessage, studio } from "./api";

/** Loads a project and keeps its chat in sync with streamed agent events. */
export function useProject(id: string) {
  const [project, setProject] = useState<OpenProject | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumps whenever files change (agent preview update, turn end, undo), so previews rebuild. */
  const [revision, setRevision] = useState(0);
  const idRef = useRef(id);
  idRef.current = id;

  const reload = useCallback(async () => {
    try {
      const p = await studio.projects.open(id);
      if (idRef.current !== id) return;
      setProject(p);
      setTurns(p.chat);
      setBusy(p.chat.some((t) => t.status === "running"));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () =>
      studio.agents.onEvent((e: AgentEvent) => {
        if (e.projectId !== idRef.current) return;
        switch (e.type) {
          case "turn.started":
            setBusy(true);
            setTurns((ts) =>
              ts.some((t) => t.turnId === e.turnId)
                ? ts
                : [...ts, { turnId: e.turnId, text: e.text, selection: e.selection, reply: "", steps: [], status: "running", startedAt: new Date().toISOString() }],
            );
            break;
          case "text":
            setTurns((ts) => ts.map((t) => (t.turnId === e.turnId ? { ...t, reply: t.reply + e.delta } : t)));
            break;
          case "step":
            setTurns((ts) =>
              ts.map((t) => {
                if (t.turnId !== e.turnId) return t;
                const step = { stepId: e.stepId, label: e.label, detail: e.detail, status: e.status };
                const has = t.steps.some((s) => s.stepId === e.stepId);
                return { ...t, steps: has ? t.steps.map((s) => (s.stepId === e.stepId ? step : s)) : [...t.steps, step] };
              }),
            );
            break;
          case "preview.updated":
            setRevision((r) => r + 1);
            void studio.projects.open(idRef.current).then((p) => setProject((cur) => (cur ? { ...cur, manifest: p.manifest } : p)));
            break;
          case "turn.completed":
            setBusy(false);
            setTurns((ts) =>
              ts.map((t) => (t.turnId === e.turnId ? { ...t, status: "done", commit: e.commit, finishedAt: new Date().toISOString(), steps: t.steps.map((s) => ({ ...s, status: s.status === "running" ? "done" : s.status })) } : t)),
            );
            setRevision((r) => r + 1);
            void studio.projects.open(idRef.current).then((p) => setProject((cur) => (cur ? { ...cur, manifest: p.manifest } : p)));
            break;
          case "turn.failed":
            setBusy(false);
            setTurns((ts) => ts.map((t) => (t.turnId === e.turnId ? { ...t, status: "error", error: e.error, finishedAt: new Date().toISOString() } : t)));
            setRevision((r) => r + 1);
            break;
        }
      }),
    [],
  );

  const send = useCallback(
    async (text: string, opts: { selection?: Selection; sceneId?: string } = {}) => {
      setError(null);
      try {
        await studio.agents.send({ projectId: id, text, selection: opts.selection, sceneId: opts.sceneId });
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [id],
  );

  const refresh = useCallback(async () => {
    await reload();
    setRevision((r) => r + 1);
  }, [reload]);

  return { project, turns, busy, error, setError, revision, send, refresh, setProject };
}
