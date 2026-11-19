import fs from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { claudeMd, projectInstructions, templates } from "@studio/agent-kit";
import type {
  ChatTurn,
  CreateProjectInput,
  OpenProject,
  ProjectManifest,
  ProjectSummary,
  SceneMeta,
} from "@studio/shared";
import { commitAll, initHistory } from "./history";
import { agentDefaults } from "./agents/models";
import { paths } from "./paths";

const MANIFEST = "project.json";

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(join(file, ".."), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 48) || "project"
  );
}

/** A short working title from the teacher's first prompt; the teacher can rename it. */
export function titleFromPrompt(prompt: string): string {
  const firstSentence = prompt.split(/[.!?\n]/)[0] ?? prompt;
  const cleaned = firstSentence
    .replace(/^(please\s+)?(make|create|build|explain|show|animate|visuali[sz]e|teach)\s+(me\s+)?(a|an|the)?\s*/i, "")
    .trim();
  const words = cleaned.split(/\s+/).slice(0, 6).join(" ");
  const t = words.charAt(0).toUpperCase() + words.slice(1);
  return t.length > 2 ? t : "Untitled";
}

class ProjectStore {
  private dirs = new Map<string, string>();

  private ensureRoot(): string {
    const root = paths.projectsDir;
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  /** Folder of a project by id. */
  dir(id: string): string {
    const cached = this.dirs.get(id);
    if (cached && fs.existsSync(join(cached, MANIFEST))) return cached;
    this.list();
    const found = this.dirs.get(id);
    if (!found) throw new Error(`Project not found: ${id}`);
    return found;
  }

  list(): ProjectSummary[] {
    const root = this.ensureRoot();
    const out: ProjectSummary[] = [];
    for (const name of fs.readdirSync(root)) {
      const dir = join(root, name);
      const m = readJson<ProjectManifest | null>(join(dir, MANIFEST), null);
      if (!m?.id) continue;
      this.dirs.set(m.id, dir);
      const thumb = join(dir, "build", "thumb.png");
      const thumbUrl = fs.existsSync(thumb) ? `studio-preview://${m.id}/thumb.png?v=${Math.round(fs.statSync(thumb).mtimeMs)}` : undefined;
      out.push({ id: m.id, kind: m.kind, title: m.title, updatedAt: m.updatedAt, dir, publish: m.publish, thumbUrl });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  manifest(id: string): ProjectManifest {
    const m = readJson<ProjectManifest | null>(join(this.dir(id), MANIFEST), null);
    if (!m) throw new Error("project.json is missing or invalid");
    return { ...m, scenes: scanScenes(this.dir(id), m.kind) };
  }

  saveManifest(m: ProjectManifest): void {
    const { scenes: _derived, ...rest } = m;
    writeJson(join(this.dir(m.id), MANIFEST), { ...rest, scenes: [], updatedAt: new Date().toISOString() });
  }

  touch(id: string): void {
    const file = join(this.dir(id), MANIFEST);
    const m = readJson<ProjectManifest | null>(file, null);
    if (m) writeJson(file, { ...m, updatedAt: new Date().toISOString() });
  }

  async create(input: CreateProjectInput): Promise<OpenProject> {
    const root = this.ensureRoot();
    const title = input.title?.trim() || titleFromPrompt(input.prompt);
    let slug = slugify(title);
    for (let i = 2; fs.existsSync(join(root, slug)); i++) slug = `${slugify(title)}-${i}`;
    const dir = join(root, slug);
    fs.mkdirSync(dir, { recursive: true });

    const now = new Date().toISOString();
    const manifest: ProjectManifest = {
      version: 1,
      id: randomUUID(),
      kind: input.kind,
      title,
      titleAuto: !input.title?.trim(),
      length: input.length,
      createdAt: now,
      updatedAt: now,
      scenes: [],
      agent: input.agent ?? { ...agentDefaults(), ...(input.provider ? { provider: input.provider } : {}) },
    };
    writeJson(join(dir, MANIFEST), manifest);
    for (const [rel, content] of Object.entries(templates(input.kind, title))) {
      fs.mkdirSync(join(dir, rel, ".."), { recursive: true });
      fs.writeFileSync(join(dir, rel), content);
    }
    this.writeAgentFiles(dir, manifest);
    this.dirs.set(manifest.id, dir);
    await initHistory(dir);
    return { manifest: { ...manifest, scenes: scanScenes(dir, manifest.kind) }, dir, chat: [] };
  }

  /** AGENTS.md, CLAUDE.md and the guide folder. Refreshed on every open so guides stay current. */
  writeAgentFiles(dir: string, m: ProjectManifest): void {
    const libsDir = join(paths.labKitDir, "node_modules");
    fs.writeFileSync(
      join(dir, "AGENTS.md"),
      projectInstructions({ kind: m.kind, title: m.title, length: m.length, audience: m.audience, libsDir }),
    );
    fs.writeFileSync(join(dir, "CLAUDE.md"), claudeMd());
    const guideDir = join(dir, ".studio", "guide");
    fs.rmSync(guideDir, { recursive: true, force: true });
    copyDir(paths.guidesDir, guideDir, (text) => text.replaceAll("{{LIBS_DIR}}", libsDir.replaceAll("\\", "/")));
  }

  async open(id: string): Promise<OpenProject> {
    const dir = this.dir(id);
    const manifest = this.manifest(id);
    this.writeAgentFiles(dir, manifest);
    return { manifest, dir, chat: this.chat(id) };
  }

  /** After the assistant's first turn, swap a prompt-derived title for the one in the content. */
  adoptContentTitle(id: string): void {
    const m = this.manifest(id);
    if (!m.titleAuto) return;
    let found: string | undefined;
    if (m.kind === "lab") {
      const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(readText(join(this.dir(id), "lab", "index.html")))?.[1];
      found = h1 ? stripTags(h1) : undefined;
    }
    if (found && found.length > 2 && found.length < 90 && found !== m.title) this.saveManifest({ ...m, title: found, titleAuto: false });
  }

  async rename(id: string, title: string): Promise<void> {
    const m = this.manifest(id);
    m.titleAuto = false;
    m.title = title.trim() || m.title;
    this.saveManifest(m);
    await commitAll(this.dir(id), `Renamed to "${m.title}"`);
  }

  remove(id: string): void {
    const dir = this.dir(id);
    fs.rmSync(dir, { recursive: true, force: true });
    this.dirs.delete(id);
  }

  chat(id: string): ChatTurn[] {
    return readJson<ChatTurn[]>(join(this.dir(id), ".studio", "chat.json"), []);
  }

  saveChat(id: string, turns: ChatTurn[]): void {
    writeJson(join(this.dir(id), ".studio", "chat.json"), turns);
  }

  /** Per-provider session ids, so conversations continue across app restarts. */
  session(id: string): Record<string, string> {
    return readJson<Record<string, string>>(join(this.dir(id), ".studio", "session.json"), {});
  }

  saveSession(id: string, value: Record<string, string>): void {
    writeJson(join(this.dir(id), ".studio", "session.json"), value);
  }
}

function copyDir(from: string, to: string, transform: (text: string) => string): void {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst, transform);
    else fs.writeFileSync(dst, transform(fs.readFileSync(src, "utf8")));
  }
}

/** The storyboard is derived from the project files, so the agent never has to maintain a list. */
export function scanScenes(dir: string, kind: ProjectManifest["kind"]): SceneMeta[] {
  if (kind === "lab") {
    const html = readText(join(dir, "lab", "index.html"));
    const sections = [...html.matchAll(/<section\b[^>]*data-part="([^"]+)"[^>]*>([\s\S]*?)<\/section>/gi)];
    if (!sections.length) return [{ id: "page", title: "Page", file: "lab/index.html", status: "sketch" }];
    return sections.map((m) => {
      const heading = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(m[2]);
      return {
        id: m[1],
        title: heading ? stripTags(heading[1]) : humanize(m[1]),
        file: "lab/index.html",
        status: "sketch",
      };
    });
  }
  const ext = kind === "video" ? ".py" : ".ts";
  const sceneDir = join(dir, "scenes");
  if (!fs.existsSync(sceneDir)) return [];
  return fs
    .readdirSync(sceneDir)
    .filter((f) => f.endsWith(ext) && f !== "index.ts" && !f.startsWith("_"))
    .sort()
    .map((f) => {
      const src = readText(join(sceneDir, f));
      const title =
        kind === "video"
          ? /class\s+\w+\s*\([^)]*\)\s*:\s*\n\s*(?:"""|''')(.+?)(?:"""|'''|\n)/.exec(src)?.[1]
          : /export\s+const\s+title\s*=\s*["'`](.+?)["'`]/.exec(src)?.[1];
      const id = basename(f, ext);
      const rendered = join(dir, "build", "scenes", `${id}.mp4`);
      return {
        id,
        title: title?.trim() || humanize(id.replace(/^\d+_/, "")),
        file: `scenes/${f}`,
        status: fs.existsSync(rendered) ? "rendered" : "sketch",
      } satisfies SceneMeta;
    });
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const projects = new ProjectStore();
