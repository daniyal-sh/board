/**
 * The speaker view of an exported deck: press S in the deck and a second window opens with the
 * current slide, the next step, the speaker notes and a timer. The two windows talk with
 * postMessage, so it works from a file on disk with no server.
 *
 * The audience window owns the deck. This window shows two "follower" copies of the deck (the
 * same file, ?follower=1) that only go where they are told, and sends next/back to the audience.
 */
import type { DeckState } from "./core";

interface SlideInfo {
  id: string;
  title: string;
  type: string;
  steps: number;
  notes: string;
}

const CSS = `
html, body { margin: 0; height: 100%; background: #0b0b0f; color: #ecebe6; font: 15px/1.5 "Segoe UI", system-ui, sans-serif; overflow: hidden; }
.sp { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100%; }
.sp-bar { display: flex; align-items: center; gap: 14px; padding: 10px 16px; border-bottom: 1px solid #23232b; }
.sp-bar b { font-variant-numeric: tabular-nums; }
.sp-timer { font: 600 26px/1 ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; color: #ffe14d; }
.sp-clock { color: #a3a1ab; font-variant-numeric: tabular-nums; }
.sp-bar button { font: inherit; color: inherit; background: #1d1d25; border: 1px solid #2e2e37; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
.sp-bar button:hover { background: #26262f; }
.sp-grow { flex: 1; }
.sp-main { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); gap: 14px; padding: 14px; min-height: 0; }
.sp-col { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.sp-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #85838e; }
.sp-frame { position: relative; width: 100%; aspect-ratio: var(--ratio); border-radius: 10px; overflow: hidden; background: #000; border: 1px solid #2e2e37; }
.sp-frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; pointer-events: none; }
.sp-notes { flex: 1; min-height: 0; overflow: auto; background: #15151b; border: 1px solid #23232b; border-radius: 10px; padding: 14px 16px; font-size: 20px; line-height: 1.5; white-space: pre-wrap; }
.sp-notes:empty::before { content: "No notes for this slide."; color: #6c6a75; }
.sp-end { display: grid; place-items: center; color: #85838e; position: absolute; inset: 0; }
`;

export function runSpeaker(aspect: "landscape" | "vertical"): void {
  document.body.innerHTML = "";
  document.title = `Speaker view · ${document.title}`;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const audience = window.opener as Window | null;
  const base = location.href.split("#")[0];
  const follower = (extra: string) => `${base}${base.includes("?") ? "&" : "?"}follower=1${extra}`;

  const root = document.createElement("div");
  root.className = "sp";
  root.style.setProperty("--ratio", aspect === "vertical" ? "9 / 16" : "16 / 9");
  root.innerHTML = `
    <div class="sp-bar">
      <span class="sp-timer" title="Time since you started">0:00</span>
      <button data-act="pause">Pause</button><button data-act="reset">Reset</button>
      <span class="sp-clock"></span>
      <span class="sp-grow"></span>
      <b class="sp-pos">–</b>
      <button data-act="prev" title="Back (←)">◀ Back</button><button data-act="next" title="Next (→ or Space)">Next ▶</button>
    </div>
    <div class="sp-main">
      <div class="sp-col"><span class="sp-label">Now</span><div class="sp-frame sp-now"><iframe title="Current slide"></iframe></div><span class="sp-title"></span></div>
      <div class="sp-col"><span class="sp-label">Next</span><div class="sp-frame sp-next"><iframe title="Next step"></iframe><div class="sp-end" hidden>End of the slides</div></div><span class="sp-label">Notes</span><div class="sp-notes"></div></div>
    </div>`;
  document.body.append(root);
  const now = root.querySelector<HTMLIFrameElement>(".sp-now iframe")!;
  const next = root.querySelector<HTMLIFrameElement>(".sp-next iframe")!;
  const end = root.querySelector<HTMLElement>(".sp-end")!;
  const notes = root.querySelector<HTMLElement>(".sp-notes")!;
  const pos = root.querySelector<HTMLElement>(".sp-pos")!;
  const title = root.querySelector<HTMLElement>(".sp-title")!;
  now.src = follower("");
  next.src = follower("&still=1");

  if (!audience) {
    notes.textContent = "Open the speaker view from the slides (press S there), so this window can follow them.";
    return;
  }

  let slides: SlideInfo[] = [];
  let state: DeckState | null = null;
  const ready = new Set<Window>();
  const toAudience = (msg: Record<string, unknown>) => audience.postMessage({ __studio: 1, ...msg }, "*");
  const toFollower = (f: HTMLIFrameElement, msg: Record<string, unknown>) => f.contentWindow?.postMessage({ __studio: 1, ...msg }, "*");

  function sync(playing: boolean): void {
    if (!state) return;
    const s = slides[state.index];
    pos.textContent = `Slide ${state.index + 1} / ${slides.length} · step ${state.step + 1} / ${state.steps}`;
    title.textContent = s?.title ?? "";
    notes.textContent = s?.notes ?? "";
    if (now.contentWindow && ready.has(now.contentWindow)) toFollower(now, { type: "deck", cmd: "goto", slide: state.slide, step: state.step, play: playing });
    // The next step: the next step of this slide, or the first step of the next slide.
    let ni = state.index;
    let nk = state.step + 1;
    if (s && nk >= s.steps) {
      ni += 1;
      nk = 0;
    }
    end.hidden = ni < slides.length;
    if (ni < slides.length && next.contentWindow && ready.has(next.contentWindow)) toFollower(next, { type: "deck", cmd: "goto", slide: slides[ni].id, step: nk, play: false });
  }

  addEventListener("message", (e) => {
    const d = e.data;
    if (!d?.__studio) return;
    if (d.type === "deck.slides") {
      slides = d.slides as SlideInfo[];
      sync(false);
    } else if (d.type === "deck.state" && e.source === audience) {
      const prev = state;
      state = d as DeckState;
      const moved = !prev || prev.slide !== state.slide || prev.step !== state.step;
      if (moved) sync(state.playing);
    } else if (d.type === "deck.ink" && e.source === audience) {
      toFollower(now, { type: "deck.ink", op: d.op });
    } else if (d.type === "deck.follower") {
      ready.add(e.source as Window);
      sync(false);
    }
  });
  toAudience({ type: "speaker.hello" });

  // Timer and clock.
  let started = Date.now();
  let pausedAt: number | null = null;
  const timer = root.querySelector<HTMLElement>(".sp-timer")!;
  const clock = root.querySelector<HTMLElement>(".sp-clock")!;
  const pauseBtn = root.querySelector<HTMLButtonElement>('[data-act="pause"]')!;
  setInterval(() => {
    const ms = (pausedAt ?? Date.now()) - started;
    const m = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    timer.textContent = `${m}:${String(sec).padStart(2, "0")}`;
    clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }, 250);
  root.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "next" || act === "prev") toAudience({ type: "deck", cmd: act });
    else if (act === "reset") {
      started = Date.now();
      if (pausedAt) pausedAt = started;
    } else if (act === "pause") {
      if (pausedAt) {
        started += Date.now() - pausedAt;
        pausedAt = null;
        pauseBtn.textContent = "Pause";
      } else {
        pausedAt = Date.now();
        pauseBtn.textContent = "Resume";
      }
    }
  });
  addEventListener("keydown", (e) => {
    const k = e.key;
    if (k === "ArrowRight" || k === "ArrowDown" || k === " " || k === "PageDown" || k === "Enter") toAudience({ type: "deck", cmd: "next" });
    else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace") toAudience({ type: "deck", cmd: "prev" });
    else if (k === "b" || k === ".") toAudience({ type: "deck", cmd: "blank" });
    else return;
    e.preventDefault();
  });
}
