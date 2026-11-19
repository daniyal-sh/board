/** What a project produces. */
export type ProjectKind = "video" | "web" | "lab";

export const PROJECT_KINDS: Record<ProjectKind, { label: string; engine: string; blurb: string }> = {
  video: { label: "Video", engine: "Manim Community", blurb: "MP4 rendered on your computer" },
  web: { label: "Web animation", engine: "manim-web", blurb: "Plays in any browser, shareable link" },
  lab: { label: "Lab", engine: "HTML", blurb: "An interactive page students can explore" },
};

export type ProjectLength = "short" | "explainer" | "lesson";

export type AgentProviderId = "claude" | "codex";

export type SceneStatus = "sketch" | "rendering" | "rendered" | "error";

/** A scene (video / web animation) or a section (lab). */
export interface SceneMeta {
  id: string;
  title: string;
  /** Path relative to the project folder, e.g. scenes/01_hook.py */
  file: string;
  status: SceneStatus;
  durationSec?: number;
}

export type Visibility = "private" | "unlisted" | "public";

export interface PublishInfo {
  id: string;
  url: string;
  visibility: Visibility;
  publishedAt: string;
}

/** Contents of project.json. */
export interface ProjectManifest {
  version: 1;
  id: string;
  kind: ProjectKind;
  title: string;
  /** The title was guessed from the first prompt; replace it once the content has a real one. */
  titleAuto?: boolean;
  length: ProjectLength;
  /** Free-text audience, e.g. "Grade 11". */
  audience?: string;
  createdAt: string;
  updatedAt: string;
  scenes: SceneMeta[];
  agent: { provider: AgentProviderId; model?: string };
  /** Narration voice settings (AI voice). */
  voice?: { voice: string; speed: number };
  publish?: PublishInfo;
}

export interface VoiceOption {
  id: string;
  label: string;
  description: string;
}

/** Narration generated or recorded for one scene. */
export interface NarrationInfo {
  source: "ai" | "recording";
  voice?: string;
  duration: number;
  /** Seconds at which each {{mark:name}} is spoken. */
  marks: Record<string, number>;
  captions: { start: number; end: number; text: string }[];
  audioUrl: string;
  /** The script changed since this audio was made. */
  stale: boolean;
}

/** A project as listed in the app (manifest plus where it lives). */
export interface ProjectSummary {
  id: string;
  kind: ProjectKind;
  title: string;
  updatedAt: string;
  dir: string;
  publish?: PublishInfo;
  /** Screenshot of the latest preview, when there is one. */
  thumbUrl?: string;
}

export interface HistoryEntry {
  id: string;
  message: string;
  timestamp: string;
}
