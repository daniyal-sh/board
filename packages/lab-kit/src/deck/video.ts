/**
 * Manim video slides: one rendered clip per animated slide. Each clip's stops come from the
 * studio_manim timeline (self.next_slide()); the deck pauses the clip at them.
 */
import type { Animator, Stop } from "./core";

export interface VideoClip {
  id: string;
  src: string;
  duration: number;
  stops: Stop[];
}

export function createVideoAnimator(clips: VideoClip[]): Animator {
  const el = document.createElement("div");
  el.dataset.part = "animation";
  const videos = new Map<string, HTMLVideoElement>();
  for (const c of clips) {
    const v = document.createElement("video");
    v.src = c.src;
    v.preload = "auto";
    v.playsInline = true;
    v.className = "deck-video";
    v.setAttribute("aria-label", "Animation");
    el.append(v);
    videos.set(c.id, v);
  }
  let active: HTMLVideoElement | null = null;
  let rate = 1;
  const ready = (v: HTMLVideoElement) =>
    v.readyState >= 2
      ? Promise.resolve()
      : new Promise<void>((r) => {
          const done = () => r();
          v.addEventListener("loadeddata", done, { once: true });
          v.addEventListener("error", done, { once: true });
          setTimeout(done, 8000);
        });
  return {
    el,
    async prepare() {
      const spans: Record<string, { start: number; stops: Stop[] }> = {};
      for (const c of clips) {
        // The last stop is always the end of the clip.
        const stops = c.stops.filter((s) => s.t < c.duration - 0.02);
        stops.push({ t: c.duration });
        spans[c.id] = { start: 0, stops };
      }
      return spans;
    },
    async enter(id) {
      const v = videos.get(id) ?? null;
      if (active && active !== v) active.pause();
      for (const [, x] of videos) x.classList.toggle("on", x === v);
      active = v;
      if (v) {
        v.playbackRate = rate;
        await ready(v);
      }
    },
    time: () => active?.currentTime ?? 0,
    seek(t) {
      const v = active;
      if (!v) return;
      // The very end shows the last frame instead of a black "ended" frame.
      const to = Math.min(t, Math.max(0, (v.duration || t) - 0.001));
      if (Math.abs(v.currentTime - to) < 0.0005) return;
      return new Promise<void>((r) => {
        const done = () => r();
        v.addEventListener("seeked", done, { once: true });
        setTimeout(done, 1500);
        v.currentTime = to;
      });
    },
    play: () => void active?.play().catch(() => {}),
    pause: () => active?.pause(),
    playing: () => Boolean(active && !active.paused && !active.ended),
    setRate(r) {
      rate = r;
      if (active) active.playbackRate = r;
    },
  };
}
