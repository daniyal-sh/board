/**
 * manim-web slides: every animated slide is recorded into one Player timeline, in deck order.
 * `await scene.nextSlide()` marks where a step ends; `await scene.waitUntil("cue")` follows the
 * narration. The deck seeks and plays this timeline; the Player's own controls stay hidden.
 */
import {
  Player,
  FadeIn,
  FadeOut,
  MathTex,
  Tex,
  MarkupText,
  Paragraph,
  DecimalNumber,
  Integer,
  Text,
  NumberPlane,
  Axes,
  NumberLine,
  SurroundingRectangle,
  Square,
  Rectangle,
  Dot,
  Circle,
  Arrow,
  Line,
  Polygon,
  FunctionGraph,
  Brace,
  VGroup,
  Group,
  type Scene,
} from "manim-web";
import type { Animator, LayoutItem, Stop } from "./core";

/** What an animated slide's default export receives. */
export type SlideScene = Scene & {
  /** End the current step here: the presenter's next click plays on. `loop` replays the step until then. */
  nextSlide(opts?: { loop?: boolean }): Promise<void>;
  /** Wait until the narration reaches {{mark:name}} (a short pause without narration). */
  waitUntil(mark: string): Promise<void>;
};

export interface WebSlide {
  id: string;
  run: (scene: SlideScene) => Promise<void> | void;
}

export interface Narration {
  audio: string;
  duration: number;
  marks: Record<string, number>;
  captions: { start: number; end: number; text: string }[];
}

const KINDS: [string, unknown][] = [
  ["MathTex", MathTex], ["Tex", Tex], ["MarkupText", MarkupText], ["Paragraph", Paragraph], ["DecimalNumber", DecimalNumber],
  ["Integer", Integer], ["Text", Text], ["NumberPlane", NumberPlane], ["Axes", Axes], ["NumberLine", NumberLine],
  ["SurroundingRectangle", SurroundingRectangle], ["Square", Square], ["Rectangle", Rectangle], ["Dot", Dot], ["Circle", Circle],
  ["Arrow", Arrow], ["Line", Line], ["Polygon", Polygon], ["FunctionGraph", FunctionGraph], ["Brace", Brace], ["VGroup", VGroup], ["Group", Group],
];
const kindOf = (m: unknown) => KINDS.find(([, C]) => typeof C === "function" && m instanceof (C as new () => unknown))?.[0];

export function createWebAnimator(slides: WebSlide[], narration: Record<string, Narration> = {}, opts: { vertical?: boolean } = {}): Animator {
  const el = document.createElement("div");
  el.dataset.part = "animation";
  const host = document.createElement("div");
  host.className = "deck-anim-host";
  const caption = document.createElement("div");
  caption.className = "deck-caption";
  caption.setAttribute("aria-live", "polite");
  el.append(host, caption);

  // The Player listens to clicks and keys on its own element; the deck owns navigation instead.
  el.addEventListener("mousedown", (e) => e.stopPropagation(), true);
  el.addEventListener(
    "click",
    (e) => {
      if (e.target === el) return;
      e.stopPropagation();
      el.parentElement?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: e.clientX, clientY: e.clientY }));
    },
    true,
  );

  let player: Player;
  const spans: { id: string; start: number; end: number }[] = [];
  const audios = new Map<string, HTMLAudioElement>();
  let rate = 1;
  let showCaptions = true;

  function sync(): void {
    if (player) {
      const t = player.timeline.getCurrentTime();
      const seg = spans.find((s) => t >= s.start && t < s.end) ?? null;
      for (const [id, a] of audios) {
        const n = narration[id];
        const local = seg && seg.id === id ? t - seg.start : -1;
        if (player.isPlaying && local >= 0 && local < n.duration) {
          if (a.playbackRate !== rate) a.playbackRate = rate;
          if (Math.abs(a.currentTime - local) > 0.25) a.currentTime = local;
          if (a.paused) a.play().catch(() => {});
        } else if (!a.paused) a.pause();
      }
      const n = seg ? narration[seg.id] : undefined;
      const local = seg ? t - seg.start : 0;
      const cap = n?.captions.find((c) => local >= c.start && local <= c.end + 0.15);
      caption.textContent = cap && showCaptions && player.isPlaying ? cap.text : "";
    }
    requestAnimationFrame(sync);
  }

  return {
    el,
    async prepare(size) {
      host.style.width = `${size.width}px`;
      host.style.height = `${size.height}px`;
      player = new Player(host, {
        ...(opts.vertical ? { frameWidth: 4.5, frameHeight: 8 } : {}),
        backgroundColor: "#0E0E12",
        allowExport: false,
        allowFullscreen: false,
        autoHideMs: 1,
      });
      for (const [id, n] of Object.entries(narration)) {
        const a = new Audio(n.audio);
        a.preload = "auto";
        audios.set(id, a);
      }
      const out: Record<string, { start: number; stops: Stop[] }> = {};
      await player.sequence(async (rec: any) => {
        for (const [index, s] of slides.entries()) {
          const t0 = player.timeline.getDuration();
          const before = new Set<unknown>((player.scene as any).mobjects);
          const n = narration[s.id];
          const stops: Stop[] = [];
          const waitUntil = async (mark: string) => {
            const at = n?.marks[mark];
            const delta = at === undefined ? 0.4 : t0 + at - player.timeline.getDuration();
            if (delta > 0.01) await rec.wait(delta);
          };
          const nextSlide = async (o: { loop?: boolean } = {}) => {
            const t = player.timeline.getDuration();
            if (stops.length && t - stops[stops.length - 1].t < 0.005) return;
            stops.push({ t, loop: Boolean(o.loop) });
          };
          const add = (...ms: any[]) => {
            const fresh = ms.filter((m) => m && !(player.scene as any).mobjects.has(m));
            if (fresh.length) void rec.play(...fresh.map((m) => new FadeIn(m, { duration: 0.001 })));
            return scene;
          };
          const remove = (...ms: any[]) => {
            const present = ms.filter((m) => m && (player.scene as any).mobjects.has(m));
            if (present.length) void rec.play(...present.map((m) => new FadeOut(m, { duration: 0.001 })));
            return scene;
          };
          const scene: any = new Proxy(rec, {
            get(target, prop) {
              if (prop === "waitUntil") return waitUntil;
              if (prop === "nextSlide") return nextSlide;
              if (prop === "add") return add;
              if (prop === "remove") return remove;
              const own = (target as any)[prop];
              if (own !== undefined) return typeof own === "function" ? own.bind(target) : own;
              const real = (player.scene as any)[prop];
              return typeof real === "function" ? real.bind(player.scene) : real;
            },
          });
          try {
            await s.run(scene);
          } catch (e) {
            console.error(`Slide ${s.id}:`, e);
          }
          if (n) {
            const need = t0 + n.duration + 0.3 - player.timeline.getDuration();
            if (need > 0.01) await rec.wait(need);
          }
          const end = player.timeline.getDuration();
          if (!stops.length || end - stops[stops.length - 1].t > 0.005) stops.push({ t: end });
          // Like a cut between slides: the next one starts on an empty stage. The fade lies after the
          // last stop, so the deck never shows it; it only keeps seeking backwards correct.
          if (index < slides.length - 1) {
            const added = [...(player.scene as any).mobjects].filter((m) => !before.has(m));
            if (added.length) await rec.play(...added.map((m: any) => new FadeOut(m, { duration: 0.05 })));
            await rec.wait(0.05);
          }
          spans.push({ id: s.id, start: t0, end: player.timeline.getDuration() });
          out[s.id] = { start: t0, stops };
        }
      });
      player.pause();
      player.seek(0);
      requestAnimationFrame(sync);
      return out;
    },
    async enter() {},
    time: () => player?.timeline.getCurrentTime() ?? 0,
    seek: (t) => player?.seek(t),
    play: () => player?.play(),
    pause: () => player?.pause(),
    playing: () => Boolean(player?.isPlaying),
    setRate(r) {
      rate = r;
      player?.setPlaybackRate(r);
    },
    setCaptions(on) {
      showCaptions = on;
    },
    layout: () => layoutNow(player),
  };
}

/** What is on screen right now, in frame coordinates (0..1 from the top-left), for layout checks. */
function layoutNow(player: Player | undefined): LayoutItem[] {
  if (!player) return [];
  const cam: any = (player.scene as any).camera;
  const fw = cam?.frameWidth ?? 14;
  const fh = cam?.frameHeight ?? 8;
  const cx = cam?.position?.x ?? 0;
  const cy = cam?.position?.y ?? 0;
  const items: LayoutItem[] = [];
  const counts: Record<string, number> = {};
  for (const m of (player.scene as any).mobjects as Set<any>) {
    try {
      if (!(m.opacity > 0.05)) continue;
      const b = m.getBounds();
      if (![b.min.x, b.min.y, b.max.x, b.max.y].every(Number.isFinite)) continue;
      const type = kindOf(m) ?? "Object";
      const text = typeof m._text === "string" ? m._text : typeof m._latex === "string" ? m._latex : "";
      counts[type] = (counts[type] ?? 0) + 1;
      const name = text ? `${type} “${text.length > 28 ? text.slice(0, 27) + "…" : text}”` : `${type} #${counts[type]}`;
      items.push({ name, type, box: { x0: (b.min.x - (cx - fw / 2)) / fw, y0: (cy + fh / 2 - b.max.y) / fh, x1: (b.max.x - (cx - fw / 2)) / fw, y1: (cy + fh / 2 - b.min.y) / fh } });
    } catch {
      /* not every object has bounds */
    }
  }
  return items;
}
