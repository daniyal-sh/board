import { useCallback, useEffect, useRef, useState } from "react";
import type { NarrationInfo, SceneMeta } from "@studio/shared";
import { studio } from "./api";

export interface NarrationData {
  /** Script per scene (markdown with {{mark:…}} cues). */
  scripts: Record<string, string>;
  /** Voice in use per scene, or null. */
  infos: Record<string, NarrationInfo | null>;
  /** Loudness per scene for the voice track (about 40 buckets a second). */
  peaks: Record<string, number[] | null>;
  loaded: boolean;
  reload: () => Promise<void>;
  /** Update one scene after an edit, without waiting for a full reload. */
  patch: (sceneId: string, p: { script?: string; info?: NarrationInfo | null }) => void;
}

/** Scripts, voices and waveforms of every scene, kept fresh as the project changes. */
export function useNarration(projectId: string, scenes: SceneMeta[], revision: number, enabled: boolean): NarrationData {
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [infos, setInfos] = useState<Record<string, NarrationInfo | null>>({});
  const [peaks, setPeaks] = useState<Record<string, number[] | null>>({});
  const [loaded, setLoaded] = useState(false);
  const ids = scenes.map((s) => s.id).join("|");
  const run = useRef(0);

  const reload = useCallback(async () => {
    if (!enabled) return;
    const mine = ++run.current;
    const list = ids ? ids.split("|") : [];
    const s: Record<string, string> = {};
    const n: Record<string, NarrationInfo | null> = {};
    const p: Record<string, number[] | null> = {};
    await Promise.all(
      list.map(async (id) => {
        const [script, info] = await Promise.all([studio.voice.script(projectId, id).catch(() => ""), studio.voice.info(projectId, id).catch(() => null)]);
        s[id] = script;
        n[id] = info;
        p[id] = info ? await studio.voice.peaks(projectId, id, Math.min(20000, Math.max(50, info.duration * 40))).catch(() => null) : null;
      }),
    );
    if (mine !== run.current) return;
    setScripts(s);
    setInfos(n);
    setPeaks(p);
    setLoaded(true);
  }, [projectId, ids, enabled]);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

  const patch = useCallback<NarrationData["patch"]>(
    (sceneId, p) => {
      if (p.script !== undefined) setScripts((s) => ({ ...s, [sceneId]: p.script! }));
      if (p.info !== undefined) {
        setInfos((s) => ({ ...s, [sceneId]: p.info! }));
        const info = p.info;
        if (info) void studio.voice.peaks(projectId, sceneId, Math.min(20000, Math.max(50, info.duration * 40))).then((pk) => setPeaks((s) => ({ ...s, [sceneId]: pk })));
        else setPeaks((s) => ({ ...s, [sceneId]: null }));
      }
    },
    [projectId],
  );

  return { scripts, infos, peaks, loaded, reload, patch };
}

const MARK = /\{\{\s*mark\s*:\s*([\w-]+)\s*\}\}/g;

/** Script text without headings, comments or cues. */
export const plainScript = (s: string) =>
  s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*#.*$/gm, "")
    .replace(MARK, "")
    .replace(/\s+/g, " ")
    .trim();

/** Cue names in a script, in order. */
export const scriptCues = (s: string) => [...s.matchAll(MARK)].map((m) => m[1]);

/**
 * A script split at its cues: text before the first cue, then one part per cue. Used by the
 * teleprompter, which moves on a part each time the teacher taps a cue.
 */
export function scriptParts(s: string): { cue?: string; text: string }[] {
  const clean = s.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*#.*$/gm, "");
  const out: { cue?: string; text: string }[] = [];
  let last = 0;
  let cue: string | undefined;
  for (const m of clean.matchAll(MARK)) {
    out.push({ cue, text: clean.slice(last, m.index).replace(/\s+/g, " ").trim() });
    cue = m[1];
    last = m.index! + m[0].length;
  }
  out.push({ cue, text: clean.slice(last).replace(/\s+/g, " ").trim() });
  return out.filter((p, i) => p.text || p.cue || i === 0);
}
