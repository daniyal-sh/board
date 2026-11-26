import type { AgentEvent, AgentRequest, ApprovalDecision, ChatTurn, ProviderStatus, Selection } from "./agent.ts";

export interface VideoEnvStatus {
  uv: boolean;
  python: boolean;
  manim: boolean;
  latex: boolean;
  ready: boolean;
}

/** Written by the studio_manim plugin for each rendered scene. Coordinates are 0–1 of the frame. */
export interface FullPreview {
  ok: boolean;
  url?: string;
  duration: number;
  /** Where each scene sits in the joined video, in seconds. */
  segments: { sceneId: string; title: string; start: number; end: number }[];
  /** Scenes that failed to render (left out of the preview). */
  failed: { sceneId: string; title: string; log: string }[];
}

export interface SceneTimeline {
  scene: string;
  duration: number;
  marks: Record<string, number>;
  /** "stop": a slide step ends here (self.next_slide() in a Slides project). */
  plays: { kind: "play" | "wait" | "mark" | "stop"; label: string; start: number; end: number; line: number | null; loop?: boolean }[];
  parts: { name: string; type: string; line: number | null; boxes: { t: number; x0: number; y0: number; x1: number; y1: number }[] }[];
}
import type {
  AgentProviderId,
  HistoryEntry,
  ProjectKind,
  ProjectLength,
  ProjectManifest,
  ProjectSummary,
  NarrationInfo,
  VoiceOption,
  TakeInfo,
  TakeEdit,
  AgentSettings,
  ProviderModels,
  Aspect,
  SlidesEngine,
} from "./project.ts";

export interface AppInfo {
  version: string;
  platform: string;
  projectsDir: string;
}

export interface CreateProjectInput {
  kind: ProjectKind;
  prompt: string;
  length: ProjectLength;
  /** Videos, web animations and slides: landscape (16:9) or vertical (9:16) for Shorts and Reels. */
  aspect?: Aspect;
  /** Slides: Manim video or manim-web for the animated slides. */
  engine?: SlidesEngine;
  title?: string;
  provider?: AgentProviderId;
  /** Model, reasoning and speed for the new project (defaults are used when omitted). */
  agent?: AgentSettings;
}

export interface OpenProject {
  manifest: ProjectManifest;
  dir: string;
  chat: ChatTurn[];
}

export interface BuildResult {
  ok: boolean;
  /** URL the preview webview should load (custom protocol). */
  previewUrl?: string;
  /** Size of the single-file HTML in bytes. */
  sizeBytes?: number;
  /** Libraries detected in the bundle, e.g. ["katex", "jsxgraph"]. */
  libraries?: string[];
  errors: string[];
}


/** The API exposed to the renderer as `window.studio`. */
export interface StudioApi {
  app: {
    info(): Promise<AppInfo>;
    openExternal(url: string): Promise<void>;
    showInFolder(path: string): Promise<void>;
  };
  agents: {
    status(refresh?: boolean): Promise<ProviderStatus[]>;
    send(req: AgentRequest): Promise<{ turnId: string }>;
    interrupt(projectId: string): Promise<void>;
    onEvent(cb: (e: AgentEvent) => void): () => void;
    /** Tell the agent tools what the teacher has selected (or clear it). */
    setSelection(projectId: string, selection: Selection | null): Promise<void>;
    /** Models, reasoning levels and fast mode each installed assistant offers (cached; refresh re-reads the CLI). */
    models(provider: AgentProviderId, refresh?: boolean): Promise<ProviderModels>;
    setSettings(projectId: string, settings: AgentSettings): Promise<void>;
    /** Answer an approval card. */
    respondApproval(projectId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
    /** Answer the assistant's questions (null skips them). */
    answerQuestions(projectId: string, requestId: string, answers: string[] | null): Promise<void>;
    /** Settings used for new projects. */
    defaults(): Promise<AgentSettings>;
    setDefaults(settings: AgentSettings): Promise<void>;
  };
  projects: {
    list(): Promise<ProjectSummary[]>;
    create(input: CreateProjectInput): Promise<OpenProject>;
    open(id: string): Promise<OpenProject>;
    rename(id: string, title: string): Promise<void>;
    remove(id: string): Promise<void>;
    history(id: string): Promise<HistoryEntry[]>;
    restore(id: string, entryId: string): Promise<void>;
    /** Undo the last change. Returns the undone version (restore it to redo), or null. */
    undo(id: string): Promise<{ undone: string; message: string } | null>;
  };
  build: {
    /** Lab / web: rebuild the preview. Video: render a draft of one scene. Slides: the animation timeline. */
    preview(projectId: string, sceneId?: string): Promise<BuildResult>;
    /** Slides: build the deck (Manim slides: renders missing drafts first; progress on video.onProgress). */
    deck(projectId: string): Promise<BuildResult & { warnings: string[] }>;
    /** Slides with large Manim clips are saved as the page plus a folder of clips (`folder`). */
    exportHtml(projectId: string): Promise<{ path: string; folder?: string } | null>;
    /** Slides: a PDF (one page per step, or per slide) or a PowerPoint file (one slide per step, with notes). */
    exportDeck(projectId: string, format: "pdf" | "pptx", opts: { perSlide: boolean }): Promise<{ path: string; count: number } | null>;
    /** Web animations: capture a picture of each scene for the storyboard. */
    thumbnails(projectId: string): Promise<void>;
    /** Build the shareable single file and put it on the clipboard. */
    copyHtml(projectId: string): Promise<{ sizeBytes: number }>;
  };
  video: {
    status(): Promise<VideoEnvStatus>;
    /** Installs Python, Manim and LaTeX; progress arrives through onSetupProgress. */
    setup(): Promise<VideoEnvStatus>;
    onSetupProgress(cb: (p: { step: string; message: string }) => void): () => void;
    /** URL of the latest draft render for a scene, or null. */
    sceneUrl(projectId: string, sceneId: string): Promise<string | null>;
    timeline(projectId: string, sceneId: string): Promise<SceneTimeline | null>;
    /** All scenes joined into one draft (renders missing or changed scenes first). */
    fullPreview(projectId: string): Promise<FullPreview>;
    onProgress(cb: (message: string) => void): () => void;
    exportMp4(projectId: string): Promise<{ path: string } | null>;
    /** Looping GIF of the whole video or web animation (asks where to save). */
    exportGif(projectId: string): Promise<{ path: string; sizeBytes: number } | null>;
  };
  /** Slides: present in an audience window while the app shows the presenter view. */
  present: {
    /** windowed: rehearse in a window on this screen instead of full screen. */
    start(projectId: string, opts: { slide?: string; step?: number; windowed?: boolean }): Promise<{ external: boolean }>;
    /** The deck's commands: { cmd: "next" | "prev" | "goto" | "tool" | "color" | "clear" | "blank", ... }. */
    command(cmd: Record<string, unknown>): Promise<void>;
    /** A pointer on the presenter's live picture, as 0..1 of the audience screen. */
    input(ev: { type: "down" | "move" | "up"; x: number; y: number; buttons?: number }): Promise<void>;
    stop(): Promise<void>;
    onState(cb: (s: { slide: string; index: number; step: number; steps: number; playing: boolean; position: number; total: number }) => void): () => void;
    onReady(cb: (d: { slides: { id: string; title: string; type: string; steps: number; notes: string }[] }) => void): () => void;
    /** A JPEG data URL of the audience screen, several times a second. */
    onFrame(cb: (dataUrl: string) => void): () => void;
    onEnded(cb: () => void): () => void;
  };
  voice: {
    voices(): Promise<VoiceOption[]>;
    script(projectId: string, sceneId: string): Promise<string>;
    saveScript(projectId: string, sceneId: string, text: string): Promise<void>;
    info(projectId: string, sceneId: string): Promise<NarrationInfo | null>;
    generate(projectId: string, sceneId: string, opts: { voice: string; speed: number }): Promise<NarrationInfo>;
    /**
     * Raw 16 kHz mono samples of the teacher's recording, saved as a new take and put in use.
     * marks: cue times the teacher tapped while recording (seconds into the take); cues not
     * tapped are found with speech recognition.
     */
    saveRecording(projectId: string, sceneId: string, pcm16k: Float32Array, opts?: { marks?: Record<string, number> }): Promise<NarrationInfo>;
    /** Loudness of the narration in use (or of a take), 0..1 per bucket. */
    peaks(projectId: string, sceneId: string, buckets: number): Promise<number[] | null>;
    takes(projectId: string, sceneId: string): Promise<TakeInfo[]>;
    useTake(projectId: string, sceneId: string, takeId: string): Promise<NarrationInfo>;
    /** Cut, re-record part of, or move the cues of the take in use; the scene re-times. */
    editTake(projectId: string, sceneId: string, edit: TakeEdit): Promise<NarrationInfo>;
    /** Undo the last edit of the take in use. */
    undoTakeEdit(projectId: string, sceneId: string): Promise<NarrationInfo | null>;
    remove(projectId: string, sceneId: string): Promise<void>;
    /**
     * Assistant writes every scene's script, then each is voiced and re-timed.
     * With scriptsReady the scripts already exist (a project started from a script): just voice them.
     */
    autoNarrate(projectId: string, opts: { voice: string; speed: number; scriptsReady?: boolean }): Promise<{ voiced: string[]; failed: { sceneId: string; error: string }[] }>;
    onProgress(cb: (message: string) => void): () => void;
  };
}

/** IPC channel names, kept in one place so main and preload agree. */
export const IPC = {
  appInfo: "app:info",
  openExternal: "app:openExternal",
  showInFolder: "app:showInFolder",
  agentsStatus: "agents:status",
  agentSend: "agent:send",
  agentInterrupt: "agent:interrupt",
  agentEvent: "agent:event",
  projectsList: "projects:list",
  projectsCreate: "projects:create",
  projectsOpen: "projects:open",
  projectsRename: "projects:rename",
  projectsRemove: "projects:remove",
  projectsHistory: "projects:history",
  projectsRestore: "projects:restore",
  projectsUndo: "projects:undo",
  buildPreview: "build:preview",
  buildDeck: "build:deck",
  buildExportHtml: "build:exportHtml",
  buildCopyHtml: "build:copyHtml",
  buildExportDeck: "build:exportDeck",
  buildThumbs: "build:thumbs",
  agentSelection: "agent:selection",
  agentModels: "agent:models",
  agentSettings: "agent:settings",
  agentApproval: "agent:approval",
  agentAnswer: "agent:answer",
  agentDefaults: "agent:defaults",
  agentSetDefaults: "agent:setDefaults",
  videoStatus: "video:status",
  videoSetup: "video:setup",
  videoSetupProgress: "video:setupProgress",
  videoSceneUrl: "video:sceneUrl",
  videoTimeline: "video:timeline",
  videoExport: "video:export",
  exportGif: "export:gif",
  videoFull: "video:full",
  videoProgress: "video:progress",
  presentStart: "present:start",
  presentCommand: "present:command",
  presentInput: "present:input",
  presentStop: "present:stop",
  presentState: "present:state",
  presentReady: "present:ready",
  presentFrame: "present:frame",
  presentEnded: "present:ended",
  voiceList: "voice:list",
  voiceScript: "voice:script",
  voiceSaveScript: "voice:saveScript",
  voiceInfo: "voice:info",
  voiceGenerate: "voice:generate",
  voiceRecording: "voice:recording",
  voiceRemove: "voice:remove",
  voicePeaks: "voice:peaks",
  voiceTakes: "voice:takes",
  voiceUseTake: "voice:useTake",
  voiceEditTake: "voice:editTake",
  voiceUndoTake: "voice:undoTake",
  voiceAuto: "voice:auto",
  voiceProgress: "voice:progress",
} as const;
