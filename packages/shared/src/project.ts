/** What a project produces. */
export type ProjectKind = "video" | "web" | "lab" | "slides";

export const PROJECT_KINDS: Record<ProjectKind, { label: string; engine: string; blurb: string }> = {
  video: { label: "Video", engine: "Manim Community", blurb: "MP4 rendered on your computer" },
  web: { label: "Web animation", engine: "manim-web", blurb: "Plays in any browser, shareable link" },
  lab: { label: "Lab", engine: "HTML", blurb: "An interactive page students can explore" },
  slides: { label: "Slides", engine: "Manim or manim-web", blurb: "A deck you present step by step" },
};

/** What draws the animated slides of a Slides project. HTML slides work with either. */
export type SlidesEngine = "video" | "web";
export const SLIDES_ENGINES: Record<SlidesEngine, { label: string; hint: string }> = {
  web: { label: "manim-web", hint: "Animations play live in the browser; nothing to install or render" },
  video: { label: "Manim video", hint: "Manim Community renders each animated slide on your computer" },
};

/**
 * How a project's animations are made: Manim videos ("video"), manim-web ("web"), or none (Labs).
 * Slides follow their engine.
 */
export function animationKind(m: { kind: ProjectKind; engine?: SlidesEngine }): "video" | "web" | null {
  if (m.kind === "slides") return m.engine ?? "web";
  return m.kind === "lab" ? null : m.kind;
}

export type ProjectLength = "short" | "explainer" | "lesson";

/** Frame shape for videos and web animations. */
export type Aspect = "landscape" | "vertical";
export const ASPECTS: Record<Aspect, { label: string; ratio: number; css: string }> = {
  landscape: { label: "16:9", ratio: 16 / 9, css: "16 / 9" },
  vertical: { label: "9:16", ratio: 9 / 16, css: "9 / 16" },
};

export type AgentProviderId = "claude" | "codex";

/** Which assistant runs a project, and how. Unset fields use the provider's own defaults. */
export interface AgentSettings {
  provider: AgentProviderId;
  /** Model id as the provider names it, e.g. "opus" or "gpt-6.2-sol". */
  model?: string;
  /** Reasoning effort, e.g. "low" | "medium" | "high" | "xhigh" | "max" (Codex also has "ultra"). */
  effort?: string;
  /** Faster responses (Claude fast mode / Codex priority tier), usually at higher usage. */
  fast?: boolean;
  /** How much the assistant may do on this computer. Defaults to "ask". */
  access?: AccessLevel;
}

/**
 * - ask: edits files in the project; commands, downloads and anything outside the project ask first
 * - auto: also runs commands and uses the web without asking, limited to the project folder
 * - full: no limits
 */
export type AccessLevel = "ask" | "auto" | "full";
/** New projects run commands and use the web inside the project folder without asking. */
export const DEFAULT_ACCESS: AccessLevel = "auto";

/** A model a provider offers, as reported by the installed CLI. */
export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  efforts: string[];
  defaultEffort?: string;
  /** Present when the model has a faster mode. */
  fast?: { label: string; description?: string };
}

export interface ProviderModels {
  provider: AgentProviderId;
  models: ModelOption[];
  /** When the list was read from the CLI (ISO). */
  fetchedAt?: string;
  error?: string;
}

export type SceneStatus = "sketch" | "rendering" | "rendered" | "error";

/** A scene (video / web animation) or a section (lab). */
export interface SceneMeta {
  id: string;
  title: string;
  /** Path relative to the project folder, e.g. scenes/01_hook.py */
  file: string;
  status: SceneStatus;
  durationSec?: number;
  /** Picture of the scene for the storyboard and timeline. */
  thumbUrl?: string;
  /** Slides: an animated slide (Manim or manim-web) or an HTML slide. */
  slideType?: "animation" | "html";
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
  /** Videos, web animations and slides. Unset means landscape. */
  aspect?: Aspect;
  /** Slides: what draws the animated slides. Unset means manim-web. */
  engine?: SlidesEngine;
  /** Free-text audience, e.g. "Grade 11". */
  audience?: string;
  createdAt: string;
  updatedAt: string;
  scenes: SceneMeta[];
  agent: AgentSettings;
  /** Narration voice settings (AI voice). */
  voice?: { voice: string; speed: number };
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
  /** Recordings: every word heard, with times in seconds. */
  words?: SpokenWord[];
  /** Recordings: which take is in use. */
  take?: string;
}

export interface SpokenWord {
  w: string;
  s: number;
  e: number;
}

/** One recording of a scene. Every take is kept; one is in use. */
export interface TakeInfo {
  id: string;
  /** 1-based, in the order they were recorded. */
  n: number;
  duration: number;
  createdAt: string;
  active: boolean;
  /** An edit can be undone. */
  canUndo?: boolean;
}

/** Edits to the take in use. Times are seconds into the take. */
export type TakeEdit =
  | { type: "cut"; start: number; end: number }
  | { type: "replace"; start: number; end: number; pcm16k: Float32Array }
  | { type: "marks"; marks: Record<string, number> };

/** A project as listed in the app (manifest plus where it lives). */
export interface ProjectSummary {
  id: string;
  kind: ProjectKind;
  title: string;
  updatedAt: string;
  dir: string;
  aspect?: Aspect;
  engine?: SlidesEngine;
  sceneCount?: number;
  /** Screenshot of the latest preview, when there is one. */
  thumbUrl?: string;
}

export interface HistoryEntry {
  id: string;
  message: string;
  timestamp: string;
}
