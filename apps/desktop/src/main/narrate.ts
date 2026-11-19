import type { AgentEvent } from "@studio/shared";
import { sendToAgent } from "./agents/manager";
import { projects } from "./projects";
import { videoEnvStatus } from "./video/env";
import { video } from "./video/renderer";
import * as voice from "./voice";

type Emit = (e: AgentEvent) => void;

/** Scenes follow the voice: re-render (video) or rebuild (web) once narration changes. */
export async function retimeScene(id: string, scene: string, progress: (m: string) => void, emit: Emit): Promise<void> {
  if (projects.manifest(id).kind === "video" && videoEnvStatus().ready) {
    progress("Re-timing the scene to the narration…");
    await video.renderPreview(id, scene);
  }
  emit({ type: "preview.updated", projectId: id });
}

/**
 * One-click narration: the assistant writes a script with cues for every scene (and adds the
 * matching waits to the scenes), then each scene gets an AI voice and is re-timed to it.
 */
export async function autoNarrate(id: string, opts: { voice: string; speed: number }, emitEvent: (e: AgentEvent) => void, progress: (m: string) => void): Promise<{ voiced: string[]; failed: { sceneId: string; error: string }[] }> {
  const m = projects.manifest(id);
  const wait = (fn: (e: AgentEvent) => void) => {
    let done!: (e: AgentEvent) => void;
    const finished = new Promise<AgentEvent>((r) => (done = r));
    return {
      finished,
      emit: (e: AgentEvent) => {
        fn(e);
        if (e.projectId === id && (e.type === "turn.completed" || e.type === "turn.failed")) done(e);
      },
    };
  };
  const w = wait(emitEvent);
  progress("The assistant is writing the narration…");
  await sendToAgent(
    {
      projectId: id,
      text:
        "Write narration for every scene: one natural script per scene in narration/<scene>.md, matched to the level of the class. " +
        "Put {{mark:name}} cues before the words where animations should start, and add the matching wait calls in each scene (" +
        (m.kind === "video" ? "self.wait_until(\"name\")" : "await scene.waitUntil(\"name\")") +
        "). Keep the animations themselves as they are.",
    },
    w.emit,
  );
  const result = await w.finished;
  if (result.type === "turn.failed") throw new Error(result.error);
  const voiced: string[] = [];
  const failed: { sceneId: string; error: string }[] = [];
  projects.saveManifest({ ...projects.manifest(id), voice: opts });
  const scenes = projects.manifest(id).scenes.filter((s) => voice.readScript(id, s.id).trim());
  for (const [i, s] of scenes.entries()) {
    try {
      progress(`Voicing “${s.title}” (${i + 1} of ${scenes.length})…`);
      await voice.generateNarration(id, s.id, opts, progress);
      await retimeScene(id, s.id, progress, emitEvent);
      voiced.push(s.id);
    } catch (e) {
      failed.push({ sceneId: s.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  emitEvent({ type: "preview.updated", projectId: id });
  return { voiced, failed };
}
