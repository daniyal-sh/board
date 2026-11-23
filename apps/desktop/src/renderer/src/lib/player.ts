import { useSyncExternalStore } from "react";

/**
 * One player for the studio. The stage (Manim video or manim-web preview) reports what it is
 * playing and takes commands; the timeline, the voice-over panel and the keyboard all read and
 * drive it through here, so they never need to know which kind of stage is on screen.
 */

export interface Segment {
  id: string;
  title: string;
  start: number;
  end: number;
}

/** One animation on the timeline (absolute times). */
export interface Step {
  start: number;
  end: number;
  label: string;
  sceneId: string;
  line?: number | null;
}

/** A {{mark:name}} cue: the moment the animation after it starts (absolute time). */
export interface Cue {
  t: number;
  name: string;
  sceneId: string;
}

/** A recording in progress, drawn live on the voice track. */
export interface LiveTake {
  sceneId: string;
  /** Timeline time when recording started. */
  start: number;
  seconds: number;
  levels: number[];
}

export interface PlayerState {
  ready: boolean;
  time: number;
  duration: number;
  playing: boolean;
  rate: number;
  loop: boolean;
  captions: boolean;
  /** Scenes on the timeline. In single-scene mode, just that scene from 0. */
  segments: Segment[];
  steps: Step[];
  cues: Cue[];
  /** "whole" shows every scene; "scene" one scene on its own. */
  view: "whole" | "scene";
  /** While recording, keys and the loop are handed to the recorder. */
  recording: boolean;
  live: LiveTake | null;
}

export interface PlayerControls {
  play(): void;
  pause(): void;
  seek(t: number): void;
  setRate(r: number): void;
  setCaptions(on: boolean): void;
}

const INITIAL: PlayerState = {
  ready: false,
  time: 0,
  duration: 0,
  playing: false,
  rate: 1,
  loop: false,
  captions: true,
  segments: [],
  steps: [],
  cues: [],
  view: "whole",
  recording: false,
  live: null,
};

export interface PlayerBus {
  get(): PlayerState;
  set(patch: Partial<PlayerState>): void;
  subscribe(fn: () => void): () => void;
  /** The stage on screen registers how to drive it. */
  attach(c: PlayerControls): () => void;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(t: number): void;
  setRate(r: number): void;
  setCaptions(on: boolean): void;
  setLoop(on: boolean): void;
}

export function createPlayerBus(): PlayerBus {
  let state = INITIAL;
  let controls: PlayerControls | null = null;
  const subs = new Set<() => void>();
  const bus: PlayerBus = {
    get: () => state,
    set(patch) {
      let changed = false;
      for (const k in patch) if ((patch as Record<string, unknown>)[k] !== (state as unknown as Record<string, unknown>)[k]) changed = true;
      if (!changed) return;
      state = { ...state, ...patch };
      subs.forEach((f) => f());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    attach(c) {
      controls = c;
      c.setRate(state.rate);
      c.setCaptions(state.captions);
      return () => {
        if (controls === c) controls = null;
      };
    },
    play: () => controls?.play(),
    pause: () => controls?.pause(),
    toggle: () => (state.playing ? controls?.pause() : controls?.play()),
    seek(t) {
      const c = Math.max(0, Math.min(state.duration || t, t));
      bus.set({ time: c });
      controls?.seek(c);
    },
    setRate(r) {
      bus.set({ rate: r });
      controls?.setRate(r);
    },
    setCaptions(on) {
      bus.set({ captions: on });
      controls?.setCaptions(on);
    },
    setLoop: (on) => bus.set({ loop: on }),
  };
  return bus;
}

export function usePlayer<T>(bus: PlayerBus, pick: (s: PlayerState) => T): T {
  return useSyncExternalStore(bus.subscribe, () => pick(bus.get()));
}

export const segmentAt = (segments: Segment[], t: number): Segment | undefined =>
  segments.find((s) => t >= s.start && t < s.end) ?? (t >= (segments[segments.length - 1]?.end ?? Infinity) ? segments[segments.length - 1] : segments[0]);

/** Start of the previous scene (or of this one, if we're more than a moment into it). */
export function prevStart(segments: Segment[], t: number): number {
  const i = segments.findIndex((s) => t >= s.start && t < s.end);
  if (i < 0) return segments[segments.length - 1]?.start ?? 0;
  if (t - segments[i].start > 1.5 || i === 0) return segments[i].start;
  return segments[i - 1].start;
}

export function nextStart(segments: Segment[], t: number): number | undefined {
  return segments.find((s) => s.start > t + 0.05)?.start;
}

export const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const fmtTenths = (s: number) => `${fmt(s)}.${Math.floor((s % 1) * 10)}`;
