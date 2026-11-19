import fs from "node:fs";
import { join } from "node:path";
import type { NarrationInfo, VoiceOption } from "@studio/shared";
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

function captionsFromWords(words: { word: string; start: number; end: number }[]): NarrationFile["captions"] {
  const out: NarrationFile["captions"] = [];
  let cur: typeof words = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.word.trim()).join(" ") });
    cur = [];
  };
  for (const w of words) {
    cur.push(w);
    if (cur.length >= 8 || /[.!?]$/.test(w.word.trim())) flush();
  }
  flush();
  return out;
}

/**
 * The renderer records with MediaRecorder, decodes and resamples to 16 kHz mono (Web Audio),
 * and sends the raw samples here.
 */
export async function narrationFromRecording(projectId: string, sceneId: string, pcm16k: Float32Array, progress: Progress): Promise<NarrationInfo> {
  progress("Loading speech recognition…");
  const model = await loadAsr(progress);
  progress("Listening to your recording…");
  const r = await model(pcm16k, { return_timestamps: "word", chunk_length_s: 30, stride_length_s: 5 });
  const duration = pcm16k.length / 16000;
  const words = (r.chunks ?? []).map((c) => ({ word: c.text, start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.3 }));
  const script = readScript(projectId, sceneId);
  const marks = script ? alignMarks(script, words, duration) : {};
  // Keep the original take next to the project (not in history), and a copy for playback.
  const takes = join(projects.dir(projectId), "audio");
  fs.mkdirSync(takes, { recursive: true });
  fs.writeFileSync(join(takes, `${sceneId}.wav`), encodeWav(pcm16k, 16000));
  return save(projectId, sceneId, pcm16k, 16000, { source: "recording", duration: Number(duration.toFixed(3)), marks, captions: captionsFromWords(words) });
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
