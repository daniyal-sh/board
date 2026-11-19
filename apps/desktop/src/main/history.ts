import fs from "node:fs";
import { join } from "node:path";
import git from "isomorphic-git";
import type { HistoryEntry } from "@studio/shared";

/**
 * Project history backed by a plain git repository (isomorphic-git, so teachers
 * do not need git installed). Every agent turn becomes one commit.
 */
const AUTHOR = { name: "Apollo Board", email: "board@localhost" };

/** Files that never belong in history. */
const IGNORE = ["build/", ".studio/", "node_modules/", "*.log", "__pycache__/", "media/", "scenes/index.ts", "audio/"].join("\n") + "\n";

export async function initHistory(dir: string): Promise<void> {
  if (fs.existsSync(join(dir, ".git"))) return;
  await git.init({ fs, dir, defaultBranch: "main" });
  fs.writeFileSync(join(dir, ".gitignore"), IGNORE);
  await commitAll(dir, "Created project");
}

/** Stage every change (including deletions) and commit. Returns the commit id, or null if nothing changed. */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  const matrix = await git.statusMatrix({ fs, dir });
  let changed = false;
  for (const [filepath, head, workdir, stage] of matrix) {
    if (head === 1 && workdir === 1 && stage === 1) continue;
    changed = true;
    if (workdir === 0) await git.remove({ fs, dir, filepath });
    else await git.add({ fs, dir, filepath });
  }
  const hasHead = await git.resolveRef({ fs, dir, ref: "HEAD" }).then(() => true, () => false);
  if (!changed && hasHead) return null;
  return git.commit({ fs, dir, message, author: AUTHOR });
}

export async function listHistory(dir: string, depth = 100): Promise<HistoryEntry[]> {
  try {
    const log = await git.log({ fs, dir, depth });
    return log.map((c) => ({
      id: c.oid,
      message: c.commit.message.trim(),
      timestamp: new Date(c.commit.author.timestamp * 1000).toISOString(),
    }));
  } catch {
    return [];
  }
}

/**
 * Make the working tree match an earlier commit and record that as a new commit,
 * so restoring is itself undoable.
 */
export async function restoreTo(dir: string, oid: string, message: string): Promise<string | null> {
  const target = new Set(await git.listFiles({ fs, dir, ref: oid }));
  const current = await git.listFiles({ fs, dir });
  for (const f of current) {
    if (!target.has(f)) fs.rmSync(join(dir, f), { force: true });
  }
  await git.checkout({ fs, dir, ref: oid, force: true, noUpdateHead: true });
  return commitAll(dir, message);
}

/** Undo the last turn: restore the parent of HEAD. */
/**
 * Undo the last change: restore the parent of HEAD. Returns the commit that was undone
 * (restore it again to redo), or null when there's nothing to undo.
 */
export async function undoLast(dir: string): Promise<{ undone: string; message: string } | null> {
  const [head, parent] = await git.log({ fs, dir, depth: 2 });
  if (!head || !parent) return null;
  const message = head.commit.message.trim().replace(/^Turn( \(stopped\))?: /, "");
  await restoreTo(dir, parent.oid, `Undo: ${message}`);
  return { undone: head.oid, message };
}
