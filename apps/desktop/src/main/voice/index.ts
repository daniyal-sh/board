import fs from "node:fs";
import { join } from "node:path";
import type { NarrationInfo, SpokenWord, TakeEdit, TakeInfo, VoiceOption } from "@studio/shared";
import { paths } from "../paths";
import { projects } from "../projects";

/**
 * Narration, fully local:
 *  - AI voice: Kokoro-82M (kokoro-js, ONNX on CPU). Each stretch of script between {{mark:…}} cues
 *    is synthesized separately, so mark times are exact sums of the audio before them.
 *  - Teacher's own recording: Whisper (word timestamps) finds when each marked word is spoken.
 * Output per scene: build/narration/<scene>.wav and .json (marks, captions), which the Manim
 * plugin and the web-animation runner read.
 */

export const VOICES: VoiceOption[] = [
  { id: "af_heart", label: "Heart", description: "Warm, American English" },
  { id: "af_bella", label: "Bella", description: "Bright, American English" },
  { id: "am_michael", label: "Michael", description: "Calm, American English" },
  { id: "am_fenrir", label: "Fenrir", description: "Deep, American English" },
  { id: "bf_emma", label: "Emma", description: "Clear, British English" },
  { id: "bm_george", label: "George", description: "Steady, British English" },
];

const TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const ASR_MODEL = "onnx-community/whisper-base_timestamped";
const SENTENCE_GAP = 0.22;

type Progress = (message: string) => void;

// ---------------------------------------------------------------- models (lazy)

type Transformers = typeof import("@huggingface/transformers");
let transformers: Promise<Transformers> | undefined;
function loadTransformers(): Promise<Transformers> {
  transformers ??= import("@huggingface/transformers").then((t) => {
    t.env.cacheDir = join(paths.dataDir, "models");
    t.env.allowRemoteModels = true;
    return t;
  });
  return transformers;
}

type Kokoro = Awaited<ReturnType<typeof import("kokoro-js").KokoroTTS.from_pretrained>>;
let tts: Promise<Kokoro> | undefined;
async function loadTts(progress: Progress): Promise<Kokoro> {
  await loadTransformers();
  tts ??= import("kokoro-js").then(({ KokoroTTS }) =>
    KokoroTTS.from_pretrained(TTS_MODEL, { dtype: "q8", device: "cpu", progress_callback: downloadProgress("voice model", progress) }),
  );
  return tts.catch((e) => {
    tts = undefined;
    throw e;
  });
}

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;
let asr: Promise<Asr> | undefined;
async function loadAsr(progress: Progress): Promise<Asr> {
  const t = await loadTransformers();
  asr ??= t
    .pipeline("automatic-speech-recognition", ASR_MODEL, { dtype: "q8", device: "cpu", progress_callback: downloadProgress("speech model", progress) })
    .then((p) => p as unknown as Asr);
  return asr.catch((e) => {
    asr = undefined;
    throw e;
  });
}

function downloadProgress(what: string, progress: Progress) {
  let last = 0;
  return (p: { status: string; progress?: number; file?: string }) => {
    if (p.status === "progress" && p.progress !== undefined && Date.now() - last > 400) {
      last = Date.now();
      progress(`Downloading the ${what} (first time only)… ${Math.round(p.progress)}%`);
    }
  };
}

// ---------------------------------------------------------------- script parsing

const MARK = /\{\{\s*mark\s*:\s*([\w-]+)\s*\}\}/g;

export interface Segment {
  /** Mark that starts at the beginning of this segment, if any. */
  mark?: string;
  text: string;
}

/** Split narration text at {{mark:name}} cues. Markdown headings and comments are ignored. */
export function parseScript(src: string): Segment[] {
  const clean = src
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join(" ");
  const out: Segment[] = [];
  let last = 0;
  let pending: string | undefined;
  for (const m of clean.matchAll(MARK)) {
    const before = clean.slice(last, m.index).trim();
    if (before) out.push({ mark: pending, text: before });
    else if (pending) out.push({ mark: pending, text: "" });
    pending = m[1];
    last = m.index! + m[0].length;
  }
  const tail = clean.slice(last).trim();
  if (tail || pending) out.push({ mark: pending, text: tail });
  return out.filter((s) => s.text || s.mark);
}

function sentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------- audio helpers

function encodeWav(samples: Float32Array, rate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- files

function narrationDir(projectId: string): string {
  const d = join(projects.dir(projectId), "build", "narration");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function scriptPath(projectId: string, sceneId: string): string {
  return join(projects.dir(projectId), "narration", `${sceneId}.md`);
}

export function readScript(projectId: string, sceneId: string): string {
  try {
    return fs.readFileSync(scriptPath(projectId, sceneId), "utf8");
  } catch {
    return "";
  }
}

export function writeScript(projectId: string, sceneId: string, text: string): void {
  fs.mkdirSync(join(projects.dir(projectId), "narration"), { recursive: true });
  fs.writeFileSync(scriptPath(projectId, sceneId), text);
}

interface NarrationFile {
  audio: string;
  source: "ai" | "recording";
  voice?: string;
  duration: number;
  marks: Record<string, number>;
  captions: { start: number; end: number; text: string }[];
  scriptHash: string;
  words?: SpokenWord[];
  take?: string;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function narrationInfo(projectId: string, sceneId: string): NarrationInfo | null {
  const file = join(projects.dir(projectId), "build", "narration", `${sceneId}.json`);
  try {
    const n = JSON.parse(fs.readFileSync(file, "utf8")) as NarrationFile;
    const wav = join(projects.dir(projectId), "build", "narration", `${sceneId}.wav`);
    return {
      source: n.source,
      voice: n.voice,
      duration: n.duration,
      marks: n.marks,
      captions: n.captions,
      audioUrl: `studio-preview://${projectId}/narration/${sceneId}.wav?v=${fs.statSync(wav).mtimeMs}`,
      stale: n.scriptHash !== hash(readScript(projectId, sceneId)),
      ...(n.words ? { words: n.words } : {}),
      ...(n.take ? { take: n.take } : {}),
    };
  } catch {
    return null;
  }
}

function save(projectId: string, sceneId: string, samples: Float32Array, rate: number, n: Omit<NarrationFile, "audio" | "scriptHash">): NarrationInfo {
  const dir = narrationDir(projectId);
  const wav = join(dir, `${sceneId}.wav`);
  fs.writeFileSync(wav, encodeWav(samples, rate));
  const data: NarrationFile = { ...n, audio: wav, scriptHash: hash(readScript(projectId, sceneId)) };
  fs.writeFileSync(join(dir, `${sceneId}.json`), JSON.stringify(data, null, 1));
  return narrationInfo(projectId, sceneId)!;
}

// ---------------------------------------------------------------- AI voice

export async function generateNarration(projectId: string, sceneId: string, opts: { voice: string; speed: number }, progress: Progress): Promise<NarrationInfo> {
  const segments = parseScript(readScript(projectId, sceneId));
  if (!segments.some((s) => s.text)) throw new Error("This scene has no narration script yet.");
  progress("Loading the voice…");
  const model = await loadTts(progress);
  const parts: Float32Array[] = [];
  const marks: Record<string, number> = {};
  const captions: NarrationFile["captions"] = [];
  let rate = 24000;
  let t = 0;
  const silence = (s: number) => {
    if (s <= 0) return;
    parts.push(new Float32Array(Math.round(s * rate)));
    t += s;
  };
  // Speak whole sentences (marks removed) so intonation stays natural, then find where each
  // marked word falls by aligning the result with speech recognition.
  const script = readScript(projectId, sceneId);
  const plain = segments.map((s) => s.text).filter(Boolean).join(" ");
  const list = sentences(plain);
  for (let i = 0; i < list.length; i++) {
    progress(`Speaking sentence ${i + 1} of ${list.length}…`);
    const audio = await model.generate(list[i], { voice: opts.voice as never, speed: opts.speed });
    rate = audio.sampling_rate;
    const start = t;
    parts.push(audio.audio);
    t += audio.audio.length / rate;
    captions.push({ start: Number(start.toFixed(3)), end: Number(t.toFixed(3)), text: list[i] });
    if (i < list.length - 1) silence(SENTENCE_GAP);
  }
  const samples = concat(parts);
  const markNames = segments.filter((s) => s.mark).map((s) => s.mark!);
  if (markNames.length) {
    try {
      progress("Lining up the cues…");
      const asrModel = await loadAsr(progress);
      const r = await asrModel(resample(samples, rate, 16000), { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 });
      const words = (r.chunks ?? []).map((c) => ({ word: c.text, start: c.timestamp[0] }));
      Object.assign(marks, alignMarks(script, words, t));
    } catch {
      // Fallback: place each mark proportionally by character position.
      let chars = 0;
      const total = plain.length || 1;
      for (const s of segments) {
        if (s.mark) marks[s.mark] = Number(((chars / total) * t).toFixed(3));
        chars += s.text.length + 1;
      }
    }
  }
  return save(projectId, sceneId, samples, rate, { source: "ai", voice: opts.voice, duration: Number(t.toFixed(3)), marks, captions });
}

function resample(src: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return src;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(src.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = src[j] * (1 - f) + (src[j + 1] ?? 0) * f;
  }
  return out;
}

// ---------------------------------------------------------------- teacher's recording

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Script words, each with the marks that sit right before it. */
function scriptWords(src: string): { word: string; marks: string[] }[] {
  const out: { word: string; marks: string[] }[] = [];
  let pendingMarks: string[] = [];
  for (const seg of parseScript(src)) {
    if (seg.mark) pendingMarks.push(seg.mark);
    for (const raw of seg.text.split(/\s+/)) {
      const w = norm(raw);
      if (!w) continue;
      out.push({ word: w, marks: pendingMarks });
      pendingMarks = [];
    }
  }
  if (pendingMarks.length) out.push({ word: "", marks: pendingMarks });
  return out;
}

/** Align script words to spoken words (LCS), then read each mark's time from its word. */
export function alignMarks(script: string, spoken: { word: string; start: number }[], duration: number): Record<string, number> {
  const a = scriptWords(script);
  const b = spoken.map((s) => norm(s.word));
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i].word && a[i].word === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const match = new Array<number>(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i].word && a[i].word === b[j]) {
      match[i] = j;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const marks: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    if (!a[i].marks.length) continue;
    // Nearest matched word at or after the mark; interpolate if none.
    let k = i;
    while (k < n && match[k] < 0) k++;
    let time: number;
    if (k < n) time = spoken[match[k]].start;
    else {
      let p = i - 1;
      while (p >= 0 && match[p] < 0) p--;
      time = p >= 0 ? spoken[match[p]].start : (i / Math.max(1, n)) * duration;
    }
    for (const mk of a[i].marks) marks[mk] = Number(Math.max(0, time - 0.05).toFixed(3));
  }
  return marks;
}

function captionsFromWords(words: SpokenWord[]): NarrationFile["captions"] {
  const out: NarrationFile["captions"] = [];
  let cur: SpokenWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ start: cur[0].s, end: cur[cur.length - 1].e, text: cur.map((w) => w.w.trim()).join(" ") });
    cur = [];
  };
  for (const w of words) {
    // A long pause starts a new caption, so captions don't hang on screen through silences.
    if (cur.length && w.s - cur[cur.length - 1].e > 1.2) flush();
    cur.push(w);
    // End at a sentence; long sentences break at a comma, or at 14 words.
    const t = w.w.trim();
    if (/[.!?]["')]?$/.test(t) || (cur.length >= 7 && /[,;:]$/.test(t)) || cur.length >= 14) flush();
  }
  flush();
  return out;
}

const round3 = (n: number) => Number(n.toFixed(3));

/** Words heard in 16 kHz mono audio, with times. */
async function transcribe(pcm16k: Float32Array, progress: Progress): Promise<SpokenWord[]> {
  if (pcm16k.length < 1600) return [];
  progress("Loading speech recognition…");
  const model = await loadAsr(progress);
  progress("Listening to your recording…");
  const r = await model(pcm16k, { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 });
  const words = (r.chunks ?? [])
    .map((c) => ({ w: c.text.trim(), s: round3(c.timestamp[0]), e: round3(c.timestamp[1] ?? c.timestamp[0] + 0.3) }))
    .filter((w) => w.w && Number.isFinite(w.s));
  return dropNonSpeech(words);
}

/** Whisper writes sounds it hears as "(music)", "[BLANK_AUDIO]" or "♪"; those aren't words. */
export function dropNonSpeech(words: SpokenWord[]): SpokenWord[] {
  const out: SpokenWord[] = [];
  let inside: string | null = null;
  for (const w of words) {
    const t = w.w;
    if (inside) {
      if (t.includes(inside)) inside = null;
      continue;
    }
    if (/^[([]/.test(t)) {
      const close = t[0] === "(" ? ")" : "]";
      if (!t.includes(close)) inside = close;
      continue;
    }
    if (/^[♪♫*\s.,!?-]+$/.test(t)) continue;
    out.push(w);
  }
  return out;
}

function marksFromWords(projectId: string, sceneId: string, words: SpokenWord[], duration: number): Record<string, number> {
  const script = readScript(projectId, sceneId);
  return script ? alignMarks(script, words.map((w) => ({ word: w.w, start: w.s })), duration) : {};
}

function cleanMarks(marks: Record<string, number> | undefined, duration: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(marks ?? {})) if (typeof v === "number" && Number.isFinite(v)) out[k] = round3(Math.max(0, Math.min(duration, v)));
  return out;
}

// ---------------------------------------------------------------- takes

/**
 * Every recording of a scene is kept as a take in audio/<scene>/take-<n>.wav (16 kHz mono) with
 * take-<n>.json (words heard, cue times). The take in use is copied to build/narration. Edits
 * change the take in use and keep the previous version next to it (.prev) for undo.
 */
interface TakeFile {
  duration: number;
  createdAt: string;
  words: SpokenWord[];
  marks: Record<string, number>;
  /** Captions kept from before takes existed (recordings made without word times). */
  captions?: NarrationFile["captions"];
}

const RATE = 16000;
const TAKE_FILE = /^(take-[0-9]+)\.json$/;

function takesDir(projectId: string, sceneId: string): string {
  return join(projects.dir(projectId), "audio", sceneId);
}

function takePath(projectId: string, sceneId: string, id: string, ext: "wav" | "json", prev = false): string {
  return join(takesDir(projectId, sceneId), `${id}${prev ? ".prev" : ""}.${ext}`);
}

function narrationJsonPath(projectId: string, sceneId: string): string {
  return join(projects.dir(projectId), "build", "narration", `${sceneId}.json`);
}

function readNarrationFile(projectId: string, sceneId: string): NarrationFile | null {
  try {
    return JSON.parse(fs.readFileSync(narrationJsonPath(projectId, sceneId), "utf8")) as NarrationFile;
  } catch {
    return null;
  }
}

function takeIds(projectId: string, sceneId: string): string[] {
  try {
    return fs
      .readdirSync(takesDir(projectId, sceneId))
      .map((f) => TAKE_FILE.exec(f)?.[1])
      .filter((x): x is string => Boolean(x))
      .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  } catch {
    return [];
  }
}

function nextTakeNumber(projectId: string, sceneId: string): number {
  const ids = takeIds(projectId, sceneId);
  return ids.length ? Number(ids[ids.length - 1].slice(5)) + 1 : 1;
}

/** Projects made before takes had one recording at audio/<scene>.wav: make it take 1. */
function migrateLegacyTake(projectId: string, sceneId: string): void {
  const legacy = join(projects.dir(projectId), "audio", `${sceneId}.wav`);
  if (!fs.existsSync(legacy)) return;
  fs.mkdirSync(takesDir(projectId, sceneId), { recursive: true });
  const id = `take-${nextTakeNumber(projectId, sceneId)}`;
  const { samples } = decodeWav(fs.readFileSync(legacy));
  const n = readNarrationFile(projectId, sceneId);
  const meta: TakeFile = {
    duration: round3(samples.length / RATE),
    createdAt: fs.statSync(legacy).mtime.toISOString(),
    words: n?.words ?? [],
    marks: n?.source === "recording" ? n.marks : {},
    captions: n?.source === "recording" && !n.words?.length ? n.captions : undefined,
  };
  fs.renameSync(legacy, takePath(projectId, sceneId, id, "wav"));
  fs.writeFileSync(takePath(projectId, sceneId, id, "json"), JSON.stringify(meta, null, 1));
  if (n?.source === "recording" && !n.take) fs.writeFileSync(narrationJsonPath(projectId, sceneId), JSON.stringify({ ...n, take: id }, null, 1));
}

function activeTake(projectId: string, sceneId: string): string | null {
  const n = readNarrationFile(projectId, sceneId);
  return n?.source === "recording" && n.take ? n.take : null;
}

function readTake(projectId: string, sceneId: string, id: string): { samples: Float32Array; meta: TakeFile } {
  const json = takePath(projectId, sceneId, id, "json");
  if (!fs.existsSync(json)) throw new Error("That recording no longer exists.");
  const meta = JSON.parse(fs.readFileSync(json, "utf8")) as TakeFile;
  const { samples } = decodeWav(fs.readFileSync(takePath(projectId, sceneId, id, "wav")));
  return { samples, meta };
}

function writeTake(projectId: string, sceneId: string, id: string, samples: Float32Array, meta: TakeFile): void {
  fs.mkdirSync(takesDir(projectId, sceneId), { recursive: true });
  fs.writeFileSync(takePath(projectId, sceneId, id, "wav"), encodeWav(samples, RATE));
  fs.writeFileSync(takePath(projectId, sceneId, id, "json"), JSON.stringify(meta, null, 1));
}

function applyTake(projectId: string, sceneId: string, id: string): NarrationInfo {
  const { samples, meta } = readTake(projectId, sceneId, id);
  return save(projectId, sceneId, samples, RATE, {
    source: "recording",
    duration: meta.duration,
    marks: meta.marks,
    captions: meta.words.length ? captionsFromWords(meta.words) : (meta.captions ?? []),
    words: meta.words,
    take: id,
  });
}

export function listTakes(projectId: string, sceneId: string): TakeInfo[] {
  migrateLegacyTake(projectId, sceneId);
  const active = activeTake(projectId, sceneId);
  return takeIds(projectId, sceneId).map((id) => {
    let meta: Partial<TakeFile> = {};
    try {
      meta = JSON.parse(fs.readFileSync(takePath(projectId, sceneId, id, "json"), "utf8")) as TakeFile;
    } catch {
      /* unreadable: still listed */
    }
    return {
      id,
      n: Number(id.slice(5)),
      duration: meta.duration ?? 0,
      createdAt: meta.createdAt ?? "",
      active: id === active,
      canUndo: fs.existsSync(takePath(projectId, sceneId, id, "json", true)),
    };
  });
}

export function useTake(projectId: string, sceneId: string, id: string): NarrationInfo {
  return applyTake(projectId, sceneId, id);
}

/**
 * The renderer records with MediaRecorder, decodes and resamples to 16 kHz mono (Web Audio),
 * and sends the raw samples here. Cues the teacher tapped while recording are kept as they are;
 * the others are found by matching the words heard to the script.
 */
export async function narrationFromRecording(projectId: string, sceneId: string, pcm16k: Float32Array, progress: Progress, tapped?: Record<string, number>): Promise<NarrationInfo> {
  const duration = round3(pcm16k.length / RATE);
  const words = await transcribe(pcm16k, progress);
  const marks = { ...marksFromWords(projectId, sceneId, words, duration), ...cleanMarks(tapped, duration) };
  migrateLegacyTake(projectId, sceneId);
  const id = `take-${nextTakeNumber(projectId, sceneId)}`;
  writeTake(projectId, sceneId, id, pcm16k, { duration, createdAt: new Date().toISOString(), words, marks });
  return applyTake(projectId, sceneId, id);
}

/** Short fades where audio was joined, so cuts don't click. */
function smoothJoin(samples: Float32Array, at: number): void {
  const n = Math.min(160, at, samples.length - at);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    samples[at - 1 - i] *= g;
    samples[at + i] *= g;
  }
}

export async function editTake(projectId: string, sceneId: string, edit: TakeEdit, progress: Progress): Promise<NarrationInfo> {
  const id = activeTake(projectId, sceneId);
  if (!id) throw new Error("This scene isn't using a recording, so there's nothing to edit.");
  const { samples, meta } = readTake(projectId, sceneId, id);
  // An older recording without word times: listen to it once, so edits keep the captions right.
  if (!meta.words.length && samples.length > RATE / 2) {
    meta.words = await transcribe(samples, progress);
    delete meta.captions;
  }
  let next = samples;
  const out: TakeFile = { ...meta, words: [...meta.words], marks: { ...meta.marks } };
  if (edit.type === "marks") {
    out.marks = { ...out.marks, ...cleanMarks(edit.marks, meta.duration) };
  } else {
    const a = Math.max(0, Math.min(meta.duration, Math.min(edit.start, edit.end)));
    const b = Math.max(0, Math.min(meta.duration, Math.max(edit.start, edit.end)));
    if (edit.type === "cut" && b - a < 0.02) throw new Error("Select a part of the recording first.");
    const insert = edit.type === "replace" ? edit.pcm16k : new Float32Array(0);
    const ia = Math.round(a * RATE);
    const ib = Math.round(b * RATE);
    next = new Float32Array(ia + insert.length + (samples.length - ib));
    next.set(samples.subarray(0, ia), 0);
    next.set(insert, ia);
    next.set(samples.subarray(ib), ia + insert.length);
    if (ia > 0) smoothJoin(next, ia);
    if (insert.length && ia + insert.length < next.length) smoothJoin(next, ia + insert.length);
    const shift = insert.length / RATE - (b - a);
    const kept = meta.words
      .filter((w) => w.e <= a + 0.03 || w.s >= b - 0.03)
      .map((w) => (w.s >= b - 0.03 ? { ...w, s: round3(w.s + shift), e: round3(w.e + shift) } : w));
    const fresh = edit.type === "replace" ? (await transcribe(insert, progress)).map((w) => ({ ...w, s: round3(w.s + a), e: round3(w.e + a) })) : [];
    out.words = [...kept, ...fresh].sort((x, y) => x.s - y.s);
    out.duration = round3(next.length / RATE);
    const realigned = edit.type === "replace" ? marksFromWords(projectId, sceneId, out.words, out.duration) : {};
    for (const [k, t] of Object.entries(meta.marks)) {
      if (t < a) continue;
      if (t >= b) out.marks[k] = round3(t + shift);
      else out.marks[k] = round3(realigned[k] ?? a);
    }
  }
  // Keep the version before this edit for undo.
  fs.copyFileSync(takePath(projectId, sceneId, id, "wav"), takePath(projectId, sceneId, id, "wav", true));
  fs.copyFileSync(takePath(projectId, sceneId, id, "json"), takePath(projectId, sceneId, id, "json", true));
  writeTake(projectId, sceneId, id, next, out);
  return applyTake(projectId, sceneId, id);
}

export function undoTakeEdit(projectId: string, sceneId: string): NarrationInfo | null {
  const id = activeTake(projectId, sceneId);
  if (!id || !fs.existsSync(takePath(projectId, sceneId, id, "json", true))) return null;
  for (const ext of ["wav", "json"] as const) fs.renameSync(takePath(projectId, sceneId, id, ext, true), takePath(projectId, sceneId, id, ext));
  return applyTake(projectId, sceneId, id);
}

// ---------------------------------------------------------------- waveforms

function decodeWav(buf: Buffer): { rate: number; samples: Float32Array } {
  let rate = 16000;
  let bits = 16;
  let channels = 1;
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(o + 10);
      rate = buf.readUInt32LE(o + 12);
      bits = buf.readUInt16LE(o + 22);
    } else if (id === "data") {
      const end = Math.min(buf.length, o + 8 + size);
      const step = (bits / 8) * channels;
      const n = Math.floor((end - o - 8) / step);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const p = o + 8 + i * step;
        out[i] = bits === 32 ? buf.readFloatLE(p) : buf.readInt16LE(p) / 32768;
      }
      return { rate, samples: out };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error("Unreadable audio file.");
}

/** Loudness per bucket (0..1, scaled so the loudest bucket is 1) of the narration in use. */
export function narrationPeaks(projectId: string, sceneId: string, buckets: number): number[] | null {
  const wav = join(projects.dir(projectId), "build", "narration", `${sceneId}.wav`);
  if (!fs.existsSync(wav)) return null;
  const { samples } = decodeWav(fs.readFileSync(wav));
  const n = Math.max(1, Math.min(20000, Math.round(buckets)));
  const out = new Array<number>(n).fill(0);
  const per = samples.length / n;
  let max = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    const end = Math.min(samples.length, Math.floor((i + 1) * per));
    for (let j = Math.floor(i * per); j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > m) m = v;
    }
    out[i] = m;
    if (m > max) max = m;
  }
  const k = max > 0.001 ? 1 / max : 0;
  return out.map((v) => Math.round(v * k * 1000) / 1000);
}

export function removeNarration(projectId: string, sceneId: string): void {
  const dir = narrationDir(projectId);
  for (const ext of ["json", "wav"]) fs.rmSync(join(dir, `${sceneId}.${ext}`), { force: true });
}

/** SRT for a whole video: captions of each scene, offset by the scenes before it. */
export function buildSrt(parts: { sceneId: string; offset: number; projectId: string }[]): string {
  const ts = (s: number) => {
    const ms = Math.round(s * 1000);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
  };
  let i = 0;
  const out: string[] = [];
  for (const part of parts) {
    const info = narrationInfo(part.projectId, part.sceneId);
    for (const c of info?.captions ?? []) out.push(`${++i}\n${ts(part.offset + c.start)} --> ${ts(part.offset + c.end)}\n${c.text}\n`);
  }
  return out.join("\n");
}
