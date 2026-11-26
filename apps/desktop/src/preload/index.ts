import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AgentEvent, type StudioApi } from "@studio/shared";

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: StudioApi = {
  app: {
    info: () => invoke(IPC.appInfo),
    openExternal: (url) => invoke(IPC.openExternal, url),
    showInFolder: (p) => invoke(IPC.showInFolder, p),
  },
  agents: {
    status: (refresh) => invoke(IPC.agentsStatus, refresh),
    send: (req) => invoke(IPC.agentSend, req),
    interrupt: (id) => invoke(IPC.agentInterrupt, id),
    onEvent: (cb) => subscribe<AgentEvent>(IPC.agentEvent, cb),
    setSelection: (id, sel) => invoke(IPC.agentSelection, id, sel),
    models: (provider, refresh) => invoke(IPC.agentModels, provider, refresh),
    setSettings: (id, settings) => invoke(IPC.agentSettings, id, settings),
    respondApproval: (id, requestId, decision) => invoke(IPC.agentApproval, id, requestId, decision),
    answerQuestions: (id, requestId, answers) => invoke(IPC.agentAnswer, id, requestId, answers),
    defaults: () => invoke(IPC.agentDefaults),
    setDefaults: (settings) => invoke(IPC.agentSetDefaults, settings),
  },
  projects: {
    list: () => invoke(IPC.projectsList),
    create: (input) => invoke(IPC.projectsCreate, input),
    open: (id) => invoke(IPC.projectsOpen, id),
    rename: (id, title) => invoke(IPC.projectsRename, id, title),
    remove: (id) => invoke(IPC.projectsRemove, id),
    history: (id) => invoke(IPC.projectsHistory, id),
    restore: (id, entry) => invoke(IPC.projectsRestore, id, entry),
    undo: (id) => invoke(IPC.projectsUndo, id),
  },
  build: {
    preview: (id, scene) => invoke(IPC.buildPreview, id, scene),
    deck: (id) => invoke(IPC.buildDeck, id),
    exportHtml: (id) => invoke(IPC.buildExportHtml, id),
    copyHtml: (id) => invoke(IPC.buildCopyHtml, id),
    thumbnails: (id) => invoke(IPC.buildThumbs, id),
  },
  present: {
    start: (id, opts) => invoke(IPC.presentStart, id, opts),
    command: (cmd) => invoke(IPC.presentCommand, cmd),
    input: (ev) => invoke(IPC.presentInput, ev),
    stop: () => invoke(IPC.presentStop),
    onState: (cb) => subscribe(IPC.presentState, cb),
    onReady: (cb) => subscribe(IPC.presentReady, cb),
    onFrame: (cb) => subscribe(IPC.presentFrame, cb),
    onEnded: (cb) => subscribe(IPC.presentEnded, cb),
  },
  video: {
    status: () => invoke(IPC.videoStatus),
    setup: () => invoke(IPC.videoSetup),
    onSetupProgress: (cb) => subscribe(IPC.videoSetupProgress, cb),
    sceneUrl: (id, scene) => invoke(IPC.videoSceneUrl, id, scene),
    timeline: (id, scene) => invoke(IPC.videoTimeline, id, scene),
    fullPreview: (id) => invoke(IPC.videoFull, id),
    onProgress: (cb) => subscribe<string>(IPC.videoProgress, cb),
    exportMp4: (id) => invoke(IPC.videoExport, id),
    exportGif: (id) => invoke(IPC.exportGif, id),
  },
  voice: {
    voices: () => invoke(IPC.voiceList),
    script: (id, scene) => invoke(IPC.voiceScript, id, scene),
    saveScript: (id, scene, text) => invoke(IPC.voiceSaveScript, id, scene, text),
    info: (id, scene) => invoke(IPC.voiceInfo, id, scene),
    generate: (id, scene, opts) => invoke(IPC.voiceGenerate, id, scene, opts),
    saveRecording: (id, scene, pcm, opts) => invoke(IPC.voiceRecording, id, scene, pcm, opts),
    peaks: (id, scene, buckets) => invoke(IPC.voicePeaks, id, scene, buckets),
    takes: (id, scene) => invoke(IPC.voiceTakes, id, scene),
    useTake: (id, scene, take) => invoke(IPC.voiceUseTake, id, scene, take),
    editTake: (id, scene, edit) => invoke(IPC.voiceEditTake, id, scene, edit),
    undoTakeEdit: (id, scene) => invoke(IPC.voiceUndoTake, id, scene),
    remove: (id, scene) => invoke(IPC.voiceRemove, id, scene),
    autoNarrate: (id, opts) => invoke(IPC.voiceAuto, id, opts),
    onProgress: (cb) => subscribe<string>(IPC.voiceProgress, cb),
  },
};

contextBridge.exposeInMainWorld("studio", api);
