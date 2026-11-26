/**
 * Board's slide deck runtime. A deck is a list of slides on a fixed canvas (1920×1080, or
 * 1080×1920 vertical) scaled to fit the screen. Every slide has steps: the presenter's next
 * click plays the next step, going back shows the end of the previous step.
 *
 * - Animated slides (Manim videos or manim-web) play on an Animator's clock and pause at stops
 *   (`self.next_slide()` / `await scene.nextSlide()`).
 * - HTML slides reveal `[data-step="n"]` elements and call the slide script's `onStep(n)`.
 *
 * The generated entry imports this module first, then each HTML slide (which calls insertSlide as
 * it loads, so the slide's own script can find its elements), then calls runDeck().
 */
import "./deck.css";
import { createInk, INK_COLORS, type InkOp, type InkTool } from "./ink";
import { runSpeaker } from "./speaker";

export interface Stop {
  /** Time on the animator's clock (seconds). */
  t: number;
  /** Replay the step that ends here until the presenter moves on. */
  loop?: boolean;
}

export interface LayoutItem {
  name: string;
  type: string;
  box: { x0: number; y0: number; x1: number; y1: number };
}

/** Drives the animated slides of one engine. */
export interface Animator {
  /** The layer that shows the animation; the deck mounts it in the stage. */
  readonly el: HTMLElement;
  /** Record or load everything; returns each animated slide's start and stops on this clock. */
  prepare(stage: { width: number; height: number }): Promise<Record<string, { start: number; stops: Stop[] }>>;
  /** Make this slide the one on screen (video: switch to its clip). */
  enter(id: string): Promise<void>;
  time(): number;
  seek(t: number): Promise<void> | void;
  play(): void;
  pause(): void;
  playing(): boolean;
  setRate?(r: number): void;
  setCaptions?(on: boolean): void;
  /** What is on screen now, 0..1 of the frame from the top-left (layout checks). */
  layout?(): LayoutItem[];
}

/** What an HTML slide's script may export. */
export interface HtmlSlideModule {
  /** Number of steps, when it isn't the highest data-step + 1. */
  steps?: number;
  onEnter?(slide: HTMLElement): void;
  onLeave?(slide: HTMLElement): void;
  /** Called with the step now shown (0 = the slide as it first appears). */
  onStep?(step: number, slide: HTMLElement): void;
}

export type SlideDef =
  | { id: string; title: string; type: "animation"; notes?: string }
  | { id: string; title: string; type: "html"; module?: HtmlSlideModule; notes?: string }
  | { id: string; title: string; type: "missing"; message: string; notes?: string };

export interface DeckConfig {
  title: string;
  aspect?: "landscape" | "vertical";
  slides: SlideDef[];
  animator?: Animator;
}

interface Slide {
  def: SlideDef;
  steps: number;
  /** Animated slides: span on the animator's clock. */
  start: number;
  stops: Stop[];
  el?: HTMLElement;
  entered: boolean;
}

export interface DeckState {
  slide: string;
  index: number;
  step: number;
  steps: number;
  playing: boolean;
  /** Position in the whole deck, counting steps. */
  position: number;
  total: number;
}

type Listener = (s: DeckState) => void;

// ------------------------------------------------------------------ DOM, created on first use

let root: HTMLElement | null = null;
let stage: HTMLElement;
let lastSlide: HTMLElement | null = null;
const htmlSlides = new Map<string, HTMLElement>();

function dims(aspect: DeckConfig["aspect"]) {
  return aspect === "vertical" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

function ensureDom(): void {
  if (root) return;
  root = document.createElement("div");
  root.className = "deck";
  root.id = "deck";
  stage = document.createElement("div");
  stage.className = "deck-stage";
  stage.dataset.part = "slide";
  root.append(stage);
  document.body.prepend(root);
}

/**
 * Called by each HTML slide module as it loads. Scoped CSS: rules apply inside this slide only.
 * `cls` comes from a `<!-- class: title -->` comment in the slide (layout helpers on the slide itself).
 */
export function insertSlide(id: string, html: string, css: string, cls = ""): HTMLElement {
  ensureDom();
  const el = document.createElement("section");
  el.className = `deck-layer deck-html ${cls}`.trim();
  el.dataset.slide = id;
  el.setAttribute("aria-roledescription", "slide");
  el.innerHTML = html;
  if (css.trim()) {
    const style = document.createElement("style");
    style.textContent = `@scope ([data-slide="${id}"]) {\n${css}\n}`;
    el.prepend(style);
  }
  stage.append(el);
  htmlSlides.set(id, el);
  lastSlide = el;
  return el;
}

/** The slide whose script is running: call at the top level of an HTML slide's script. */
export function thisSlide(): HTMLElement {
  if (!lastSlide) throw new Error("thisSlide() is only available inside an HTML slide's script");
  return lastSlide;
}

// ------------------------------------------------------------------ the deck

const params = new URLSearchParams(location.search);
const preview = () => Boolean((window as unknown as { __studioPreview?: boolean }).__studioPreview);

export async function runDeck(cfg: DeckConfig): Promise<void> {
  ensureDom();
  const size = dims(cfg.aspect);
  stage.style.width = `${size.width}px`;
  stage.style.height = `${size.height}px`;
  const still = params.has("still");
  if (still) root!.classList.add("deck-still");
  if (preview()) document.documentElement.classList.add("studio-preview");

  const animator = cfg.animator;
  if (animator) {
    animator.el.classList.add("deck-layer", "deck-anim");
    stage.prepend(animator.el);
  }

  const fit = () => {
    const s = Math.min(innerWidth / size.width, innerHeight / size.height);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  };
  addEventListener("resize", fit);
  fit();

  // An exported deck opened as its own speaker view (press S in the deck).
  if (location.hash === "#speaker") {
    root!.remove();
    runSpeaker(cfg.aspect ?? "landscape");
    return;
  }
  /** A copy of the deck that only goes where it is told (speaker view panes, presenter previews). */
  const follower = params.has("follower");
  /** The audience window of the app's presenter: reports its position to the app. */
  const presenting = params.has("present");
  if (follower) root!.classList.add("deck-follower");

  let spans: Record<string, { start: number; stops: Stop[] }> = {};
  if (animator) {
    try {
      spans = await animator.prepare(size);
    } catch (e) {
      console.error(e);
    }
  }

  const slides: Slide[] = cfg.slides.map((def) => {
    const s: Slide = { def, steps: 1, start: 0, stops: [], entered: false };
    if (def.type === "animation") {
      const span = spans[def.id];
      if (span && span.stops.length) {
        s.start = span.start;
        s.stops = span.stops;
        s.steps = span.stops.length;
      } else {
        s.def = { id: def.id, title: def.title, type: "missing", message: "This slide's animation didn't load. Check the console for errors.", notes: def.notes };
      }
    } else if (def.type === "html") {
      s.el = htmlSlides.get(def.id);
      const marked = s.el ? [...s.el.querySelectorAll<HTMLElement>("[data-step], [data-step-hide]")] : [];
      const highest = marked.reduce((m, e) => Math.max(m, Number(e.dataset.step ?? 0) || 0, Number(e.dataset.stepHide ?? 0) || 0), 0);
      s.steps = Math.max(1, def.module?.steps ?? highest + 1);
    }
    if (s.def.type === "missing") {
      const el = document.createElement("section");
      el.className = "deck-layer deck-html deck-missing";
      el.dataset.slide = def.id;
      el.innerHTML = `<div class="deck-missing-box"><h2></h2><p></p></div>`;
      el.querySelector("h2")!.textContent = def.title;
      el.querySelector("p")!.textContent = (s.def as { message: string }).message;
      stage.append(el);
      s.el = el;
    }
    return s;
  });
  for (const s of slides) if (s.el) s.el.inert = true;

  // ---------------------------------------------------------------- state

  let cur = { i: 0, k: 0 };
  let target: { i: number; from: number; to: number; loop: boolean } | null = null;
  let shown: Slide | null = null;
  const listeners = new Set<Listener>();
  const offsets: number[] = [];
  let total = 0;
  for (const s of slides) {
    offsets.push(total);
    total += s.steps;
  }

  const state = (): DeckState => ({
    slide: slides[cur.i]?.def.id ?? "",
    index: cur.i,
    step: cur.k,
    steps: slides[cur.i]?.steps ?? 1,
    playing: Boolean(target),
    position: (offsets[cur.i] ?? 0) + cur.k,
    total,
  });
  let lastKey = "";
  let lastPlace = "";
  let speaker: Window | null = null;
  const emit = () => {
    const s = state();
    const key = JSON.stringify(s);
    if (key === lastKey) return;
    lastKey = key;
    // Ink belongs to the step it was drawn on.
    const place = `${s.slide}:${s.step}`;
    if (place !== lastPlace) {
      lastPlace = place;
      ink?.apply({ op: "clear" });
    }
    hud.update(s, slides[cur.i]?.def.title ?? "");
    listeners.forEach((f) => f(s));
    if (preview() && window.parent !== window) parent.postMessage({ __studio: 1, type: "deck.state", ...s }, "*");
    if (speaker && !speaker.closed) speaker.postMessage({ __studio: 1, type: "deck.state", ...s }, "*");
    if (presenting) console.debug(`__board_deck__${JSON.stringify({ type: "state", ...s })}`);
  };

  const range = (s: Slide, k: number) => ({ from: k === 0 ? s.start : s.stops[k - 1].t, to: s.stops[k].t, loop: Boolean(s.stops[k].loop) });

  /** Put slide i on screen (no step logic). */
  async function show(i: number): Promise<void> {
    const s = slides[i];
    if (shown === s) return;
    if (shown) {
      if (shown.def.type === "html" && shown.el) shown.def.module?.onLeave?.(shown.el);
      shown.el?.removeAttribute("data-active");
      if (shown.el) shown.el.inert = true;
    }
    const anim = s.def.type === "animation";
    if (animator) {
      if (anim) {
        animator.el.setAttribute("data-active", "");
        await animator.enter(s.def.id);
      } else {
        animator.pause();
        animator.el.removeAttribute("data-active");
      }
    }
    if (s.el) {
      s.el.setAttribute("data-active", "");
      s.el.inert = false;
      if (s.def.type === "html") {
        s.def.module?.onEnter?.(s.el);
        s.entered = true;
      }
    }
    shown = s;
  }

  function applyHtml(s: Slide, k: number): void {
    if (!s.el || s.def.type !== "html") return;
    for (const e of s.el.querySelectorAll<HTMLElement>("[data-step]")) {
      const n = Number(e.dataset.step) || 0;
      e.classList.toggle("deck-pending", n > k);
      e.classList.toggle("deck-step-current", n === k);
    }
    for (const e of s.el.querySelectorAll<HTMLElement>("[data-step-hide]")) {
      if (Number(e.dataset.stepHide) <= k) e.classList.add("deck-pending");
    }
    try {
      s.def.module?.onStep?.(k, s.el);
    } catch (e) {
      console.error(e);
    }
  }

  /** Show the end of step k of slide i, paused. */
  async function settle(i: number, k: number): Promise<void> {
    i = clamp(i, 0, slides.length - 1);
    k = clamp(k, 0, slides[i].steps - 1);
    target = null;
    cur = { i, k };
    await show(i);
    const s = slides[i];
    if (s.def.type === "animation" && animator) {
      animator.pause();
      await animator.seek(range(s, k).to);
    } else applyHtml(s, k);
    emit();
  }

  /** Play step k of slide i from its start to its stop. */
  async function playStep(i: number, k: number): Promise<void> {
    cur = { i, k };
    await show(i);
    const s = slides[i];
    if (s.def.type !== "animation" || !animator) {
      target = null;
      applyHtml(s, k);
      emit();
      return;
    }
    const r = range(s, k);
    if (r.to - r.from < 0.005) {
      animator.pause();
      await animator.seek(r.to);
      target = null;
      emit();
      return;
    }
    await animator.seek(r.from);
    target = { i, ...r };
    animator.play();
    emit();
  }

  function tick(): void {
    if (target && animator) {
      const t = animator.time();
      if (t >= target.to - 0.0005 || !animator.playing()) {
        if (target.loop && animator.playing()) {
          void animator.seek(target.from);
        } else {
          animator.pause();
          void animator.seek(target.to);
          target = null;
          emit();
        }
      }
    }
    requestAnimationFrame(tick);
  }

  const api = {
    next: async () => {
      if (target && !target.loop) return settle(cur.i, cur.k);
      const s = slides[cur.i];
      if (cur.k + 1 < s.steps) return playStep(cur.i, cur.k + 1);
      if (cur.i + 1 < slides.length) return playStep(cur.i + 1, 0);
      if (target) return settle(cur.i, cur.k);
    },
    prev: async () => {
      if (cur.k > 0) return settle(cur.i, cur.k - 1);
      if (cur.i > 0) return settle(cur.i - 1, slides[cur.i - 1].steps - 1);
      return settle(0, 0);
    },
    /** Jump to a slide (by id or index) and step; `play` plays that step instead of showing its end. */
    goto: async (slide: string | number, step = 0, play = false) => {
      const i = typeof slide === "number" ? slide : slides.findIndex((s) => s.def.id === slide);
      if (i < 0) return;
      return play ? playStep(i, step) : settle(i, step);
    },
    /** Step through the deck as one list: position 0..total-1. */
    gotoPosition: async (p: number) => {
      p = clamp(p, 0, total - 1);
      let i = 0;
      while (i + 1 < slides.length && offsets[i + 1] <= p) i++;
      return settle(i, p - offsets[i]);
    },
    state,
    subscribe: (f: Listener) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    slides: slides.map((s) => ({ id: s.def.id, title: s.def.title, type: s.def.type, steps: s.steps, notes: s.def.notes ?? "" })),
    setRate: (r: number) => animator?.setRate?.(r),
    setCaptions: (on: boolean) => animator?.setCaptions?.(on),
  };
  deckApi = api;
  const settled = async () => {
    for (let i = 0; i < 600 && target; i++) await frames(1);
    await frames(2);
  };

  // ---------------------------------------------------------------- input

  const blank = document.createElement("div");
  blank.className = "deck-blank";
  root!.append(blank);
  const toggleBlank = () => blank.classList.toggle("on");
  const openSpeaker = () => {
    if (speaker && !speaker.closed) return speaker.focus();
    speaker = window.open(`${location.href.split("#")[0]}#speaker`, "board-speaker", "width=1280,height=780");
  };
  const ink: ReturnType<typeof createInk> | null = createInk(
    stage,
    size,
    (op) => {
      if (speaker && !speaker.closed) speaker.postMessage({ __studio: 1, type: "deck.ink", op }, "*");
    },
    (t) => hud?.setTool(t),
  );
  const hud = createHud(root!, api, { ink, openSpeaker: follower || preview() ? null : openSpeaker });
  const overview = createOverview(root!, api);
  const setTool = (t: InkTool) => ink.setTool(ink.tool() === t ? "pointer" : t);

  let typed = "";
  addEventListener("keydown", (e) => {
    if (follower || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const inWidget = t && t !== document.body && t.closest?.(".deck-html") && isInteractive(t);
    if (e.key === "Escape") {
      if (overview.open) overview.toggle(false);
      else if (ink.tool() !== "pointer") ink.setTool("pointer");
      else if (inWidget) t!.blur();
      else if (presenting) console.debug(`__board_deck__${JSON.stringify({ type: "exit" })}`);
      return;
    }
    if (inWidget) return;
    const k = e.key;
    if (/^[0-9]$/.test(k)) {
      typed += k;
      return;
    }
    if (k === "Enter" && typed) {
      void api.goto(Number(typed) - 1, 0, true);
      typed = "";
      e.preventDefault();
      return;
    }
    typed = "";
    if (k === "ArrowRight" || k === "ArrowDown" || k === " " || k === "PageDown" || k === "Enter" || k === "n") void api.next();
    else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace") void api.prev();
    else if (k === "Home") void api.goto(0, 0, true);
    else if (k === "End") void api.goto(slides.length - 1, slides[slides.length - 1].steps - 1);
    else if (k === "o" || k === "g") overview.toggle();
    else if (k === "b" || k === ".") toggleBlank();
    else if (k === "p") setTool("pen");
    else if (k === "h") setTool("highlighter");
    else if (k === "l") setTool("laser");
    else if (k === "e") setTool("eraser");
    else if (k === "c") ink.clear();
    else if (k === "s" && !preview()) openSpeaker();
    else if (k === "f") void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())?.catch(() => {});
    else return;
    e.preventDefault();
  });

  // A click on an animation or a static slide moves on; slides with their own controls keep their clicks.
  stage.addEventListener("click", (e) => {
    if (follower || document.documentElement.classList.contains("studio-picking")) return;
    const s = slides[cur.i];
    const t = e.target as HTMLElement;
    if (isInteractive(t)) return;
    if (s.def.type === "html" && s.def.module && !s.el?.hasAttribute("data-click-advances")) return;
    void api.next();
  });

  // Commands from the app's preview (and, later, the presenter window).
  addEventListener("message", (e) => {
    const d = e.data;
    if (!d || !d.__studio) return;
    if (d.type === "pick") document.documentElement.classList.toggle("studio-picking", Boolean(d.on));
    if (d.type === "speaker.hello") {
      (e.source as Window | null)?.postMessage({ __studio: 1, type: "deck.slides", slides: api.slides }, "*");
      (e.source as Window | null)?.postMessage({ __studio: 1, type: "deck.state", ...state() }, "*");
      return;
    }
    if (d.type === "deck.ink") return ink.apply(d.op as InkOp);
    if (d.type !== "deck") return;
    if (d.cmd === "tool") {
      ink.setTool(d.tool as InkTool);
      if (d.color) ink.setColor(String(d.color));
    } else if (d.cmd === "color") ink.setColor(String(d.color));
    else if (d.cmd === "clear") ink.clear();
    else if (d.cmd === "blank") d.value === undefined ? toggleBlank() : blank.classList.toggle("on", Boolean(d.value));
    else if (d.cmd === "next") void api.next();
    else if (d.cmd === "prev") void api.prev();
    else if (d.cmd === "goto") void api.goto(d.slide, Number(d.step) || 0, Boolean(d.play));
    else if (d.cmd === "rate") api.setRate(Number(d.value) || 1);
    else if (d.cmd === "captions") api.setCaptions(Boolean(d.value));
  });

  // ---------------------------------------------------------------- start

  requestAnimationFrame(tick);
  const startId = params.get("slide");
  const startIndex = startId ? Math.max(0, slides.findIndex((s) => s.def.id === startId)) : 0;
  const startStep = Number(params.get("step") ?? 0) || 0;
  if (slides.length) {
    if (still || startId) await settle(startIndex, startStep);
    else await playStep(0, 0);
  }

  (window as unknown as { __studioDeck: unknown }).__studioDeck = {
    ready: true,
    slides: api.slides,
    /** Settle on a step and wait until it is painted. */
    goto: async (slide: string | number, step: number) => {
      await api.goto(slide, step);
      await frames(2);
      return state();
    },
    state,
    /** Step forward or back, then wait until the step has finished playing. */
    next: async () => {
      await api.next();
      await settled();
      return state();
    },
    prev: async () => {
      await api.prev();
      await frames(2);
      return state();
    },
    layout: () => (slides[cur.i]?.def.type === "animation" ? animator?.layout?.() ?? [] : htmlLayout(slides[cur.i]?.el, size)),
    probe: () => htmlProbe(slides[cur.i]?.el, size),
    ink: { tool: () => ink.tool(), setTool: (t: InkTool) => ink.setTool(t), hasInk: () => ink.hasInk(), apply: (op: InkOp) => ink.apply(op) },
  };
  if (preview() && window.parent !== window) parent.postMessage({ __studio: 1, type: "deck.ready", slides: api.slides, aspect: cfg.aspect ?? "landscape" }, "*");
  if (follower && window.parent !== window) parent.postMessage({ __studio: 1, type: "deck.follower" }, "*");
  if (presenting) console.debug(`__board_deck__${JSON.stringify({ type: "ready", slides: api.slides })}`);
  emit();
}

export type DeckApi = {
  next(): Promise<void>;
  prev(): Promise<void>;
  goto(slide: string | number, step?: number, play?: boolean): Promise<void>;
  gotoPosition(p: number): Promise<void>;
  state(): DeckState;
  subscribe(f: Listener): () => void;
  slides: { id: string; title: string; type: string; steps: number; notes: string }[];
  setRate(r: number): void;
  setCaptions(on: boolean): void;
};

let deckApi: DeckApi | null = null;
/** The running deck (after runDeck has started). */
export function deck(): DeckApi | null {
  return deckApi;
}

// ------------------------------------------------------------------ helpers

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function frames(n: number): Promise<void> {
  return new Promise((r) => {
    const step = () => (--n <= 0 ? r() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

function isInteractive(el: HTMLElement | null): boolean {
  if (!el?.closest) return false;
  return Boolean(
    el.closest(
      "a[href], button, input, select, textarea, label, summary, [contenteditable], [role=button], [role=slider], [tabindex]:not([tabindex='-1']), canvas, .jxgbox, [data-interactive], lab-slider, lab-check, lab-steps, lab-reveal",
    ) && !el.closest(".deck-anim"),
  );
}

function createHud(host: HTMLElement, api: { gotoPosition(p: number): Promise<void> }, extra: { ink: ReturnType<typeof createInk>; openSpeaker: (() => void) | null }) {
  const hud = document.createElement("div");
  hud.className = "deck-hud";
  hud.innerHTML = `<div class="deck-tools" role="toolbar" aria-label="Presenting tools">
      <button data-tool="pen" title="Pen (P)">✎</button>
      <button data-tool="highlighter" title="Highlighter (H)">▮</button>
      <button data-tool="laser" title="Laser pointer (L)">●</button>
      <button data-tool="eraser" title="Eraser (E)">⌫</button>
      <button data-act="clear" title="Clear the ink (C)">✕</button>
      <span class="deck-colors"></span>
      ${extra.openSpeaker ? '<button data-act="speaker" title="Speaker view (S)">Speaker view</button>' : ""}
    </div><div class="deck-progress"><i></i></div><span class="deck-count"></span>`;
  host.append(hud);
  const bar = hud.querySelector<HTMLElement>(".deck-progress i")!;
  const count = hud.querySelector<HTMLElement>(".deck-count")!;
  const colors = hud.querySelector<HTMLElement>(".deck-colors")!;
  for (const c of INK_COLORS) {
    const b = document.createElement("button");
    b.className = "deck-color";
    b.style.background = c;
    b.title = "Ink colour";
    b.dataset.color = c;
    colors.append(b);
  }
  const markColor = () => colors.querySelectorAll<HTMLElement>("[data-color]").forEach((b) => b.toggleAttribute("aria-pressed", b.dataset.color === extra.ink.color()));
  markColor();
  hud.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.tool) {
      const t = b.dataset.tool as InkTool;
      extra.ink.setTool(extra.ink.tool() === t ? "pointer" : t);
    } else if (b.dataset.color) {
      extra.ink.setColor(b.dataset.color);
      if (extra.ink.tool() === "pointer" || extra.ink.tool() === "laser" || extra.ink.tool() === "eraser") extra.ink.setTool("pen");
      markColor();
    } else if (b.dataset.act === "clear") extra.ink.clear();
    else if (b.dataset.act === "speaker") extra.openSpeaker?.();
  });
  let hideTimer = 0;
  let total = 1;
  const wake = () => {
    hud.classList.add("awake");
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => hud.classList.remove("awake"), 2600);
  };
  addEventListener("pointermove", wake);
  hud.querySelector(".deck-progress")!.addEventListener("click", (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    void api.gotoPosition(Math.floor((((e as MouseEvent).clientX - r.left) / r.width) * total));
  });
  return {
    update(s: DeckState, title: string) {
      total = s.total;
      bar.style.width = `${((s.position + 1) / Math.max(1, s.total)) * 100}%`;
      count.textContent = `${s.index + 1} · ${title}${s.steps > 1 ? ` · ${s.step + 1}/${s.steps}` : ""}`;
    },
    setTool(t: InkTool) {
      hud.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => b.toggleAttribute("aria-pressed", b.dataset.tool === t));
      host.dataset.tool = t;
    },
  };
}

function createOverview(host: HTMLElement, api: { slides: { id: string; title: string; steps: number }[]; goto(s: number, k?: number, play?: boolean): Promise<void>; state(): DeckState }) {
  const el = document.createElement("div");
  el.className = "deck-overview";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "All slides");
  host.append(el);
  const o: { open: boolean; toggle(on?: boolean): void } = {
    open: false,
    toggle(on = !o.open) {
      o.open = on;
      el.classList.toggle("on", on);
      if (!on) return;
      el.innerHTML = "";
      const cur = api.state().index;
      api.slides.forEach((s, i) => {
        const b = document.createElement("button");
        b.className = "deck-overview-item";
        if (i === cur) b.setAttribute("aria-current", "true");
        b.innerHTML = `<b></b><span></span>`;
        b.querySelector("b")!.textContent = String(i + 1);
        b.querySelector("span")!.textContent = s.title;
        b.addEventListener("click", () => {
          o.toggle(false);
          void api.goto(i, 0, true);
        });
        el.append(b);
      });
      (el.children[cur] as HTMLElement | undefined)?.focus();
    },
  };
  return o;
}

/** Text and boxes of the HTML slide on screen, in frame coordinates (0..1), for layout checks. */
function htmlLayout(el: HTMLElement | undefined, size: { width: number; height: number }): LayoutItem[] {
  if (!el) return [];
  const frame = el.getBoundingClientRect();
  const sx = frame.width / size.width;
  const items: LayoutItem[] = [];
  for (const n of el.querySelectorAll<HTMLElement>("h1, h2, h3, h4, p, li, figure, img, svg, canvas, table, [data-part], .katex-display")) {
    if (n.closest(".deck-pending") || n.parentElement?.closest("svg")) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const text = (n.textContent ?? "").trim().replace(/\s+/g, " ");
    const name = n.dataset.part ?? (text ? `${n.tagName.toLowerCase()} “${text.length > 28 ? text.slice(0, 27) + "…" : text}”` : n.tagName.toLowerCase());
    items.push({
      name,
      type: /^H\d$/.test(n.tagName) || n.tagName === "P" || n.tagName === "LI" ? "Text" : "Object",
      box: { x0: (r.left - frame.left) / sx / size.width, y0: (r.top - frame.top) / sx / size.height, x1: (r.right - frame.left) / sx / size.width, y1: (r.bottom - frame.top) / sx / size.height },
    });
  }
  return items;
}

/** Problems a teacher would notice on an HTML slide: off the slide, too small to read, cut off. */
function htmlProbe(el: HTMLElement | undefined, size: { width: number; height: number }): { findings: string[]; controls: string[] } {
  if (!el) return { findings: [], controls: [] };
  const frame = el.getBoundingClientRect();
  const sx = frame.width / size.width;
  const out = new Set<string>();
  const offSlide = new Set<Element>();
  const name = (n: Element) => {
    const part = n.closest("[data-part]")?.getAttribute("data-part");
    const text = (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    return (part ? `[${part}] ` : "") + n.tagName.toLowerCase() + (text ? ` “${text}”` : "");
  };
  let small = false;
  for (const n of el.querySelectorAll<HTMLElement>("*")) {
    if (n.closest(".deck-pending, style, script") || n.parentElement?.closest("svg")) continue;
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = n.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const off = (r.right - frame.right) / sx > 4 || (r.bottom - frame.bottom) / sx > 4 || (frame.left - r.left) / sx > 4 || (frame.top - r.top) / sx > 4;
    // Only the outermost element that leaves the slide.
    if (off && ![...offSlide].some((o) => o.contains(n))) {
      offSlide.add(n);
      out.add(`Off the slide: ${name(n)}`);
    }
    const direct = [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim());
    // Labels drawn by a widget (JSXGraph, KaTeX…) follow its own sizing; only the slide's own text counts.
    if (direct && !small && parseFloat(cs.fontSize) < 24 && !n.closest(".jxgbox, [class*=\"JXG\"], .katex, [data-interactive]")) {
      small = true;
      out.add(`Text too small to read from the back of a room (${Math.round(parseFloat(cs.fontSize))} px on a ${size.height}p slide; use 28 px or more): ${name(n)}`);
    }
    if (direct && (cs.overflow.includes("hidden") || cs.textOverflow === "ellipsis") && n.scrollWidth > n.clientWidth + 2) out.add(`Text is cut off: ${name(n)}`);
    if (n.tagName === "IMG" && (n as HTMLImageElement).complete && !(n as HTMLImageElement).naturalWidth) out.add(`Image did not load: ${name(n)}`);
  }
  const findings = [...out];
  const controls = [...el.querySelectorAll<HTMLElement>("input, select, textarea, button, [role=slider], [role=button], a[href], [data-part][tabindex]")].slice(0, 30).map((c) => {
    const t = c.tagName.toLowerCase() + ((c as HTMLInputElement).type ? `[${(c as HTMLInputElement).type}]` : "");
    const v = (c as HTMLInputElement).type === "range" ? ` value=${(c as HTMLInputElement).value}` : "";
    return `${name(c)} · ${t}${v}`;
  });
  return { findings: findings.slice(0, 14), controls };
}
