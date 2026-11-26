import { useEffect, useRef, useState } from "react";
import type { Aspect, SceneMeta, Selection } from "@studio/shared";
import { errorMessage, studio } from "../lib/api";
import { Cursor, Next, Present, Prev, Refresh } from "./Icons";
import { StageFrame, StatusNote } from "./StageParts";

export interface DeckSlide {
  id: string;
  title: string;
  type: string;
  steps: number;
  notes: string;
}

export interface DeckPosition {
  slide: string;
  index: number;
  step: number;
  steps: number;
  playing: boolean;
  position: number;
  total: number;
}

interface ConsoleLine {
  level: string;
  text: string;
}

/**
 * Slides: the deck as it will be presented, on its fixed canvas. The teacher steps through it
 * here (or presses Present); the filmstrip below shows every slide and its steps.
 */
export function SlidesStage(props: {
  projectId: string;
  revision: number;
  busy: boolean;
  aspect?: Aspect;
  slides: SceneMeta[];
  activeSlide?: SceneMeta;
  onActiveSlide: (id: string) => void;
  selection: Selection | null;
  onSelect: (part: string | null, info?: { tag?: string; text?: string; slide?: string; step?: number }) => void;
  onThumbnails?: () => void;
  onPresent?: (pos: DeckPosition | null, slides: DeckSlide[]) => void;
  leading?: React.ReactNode;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const frameBox = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [building, setBuilding] = useState<string | null>(null);
  const [builtAt, setBuiltAt] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [deckSlides, setDeckSlides] = useState<DeckSlide[]>([]);
  const [pos, setPos] = useState<DeckPosition | null>(null);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const builds = useRef(0);
  const posRef = useRef<DeckPosition | null>(null);
  posRef.current = pos;
  const thumbsFor = useRef(-1);

  async function build() {
    const mine = ++builds.current;
    setBuilding("Building the slides…");
    const off = studio.video.onProgress((m) => mine === builds.current && setBuilding(m));
    try {
      const r = await studio.build.deck(props.projectId);
      if (mine !== builds.current) return;
      setErrors(r.errors);
      setWarnings(r.warnings ?? []);
      if (r.ok && r.previewUrl) {
        setConsoleLines([]);
        // Rebuilds keep the teacher where they were.
        const p = posRef.current;
        const at = p ? `&slide=${encodeURIComponent(p.slide)}&step=${p.step}` : "";
        setUrl(r.previewUrl + at);
        setBuiltAt(Date.now());
      }
    } catch (e) {
      if (mine === builds.current) setErrors([errorMessage(e)]);
    } finally {
      off();
      if (mine === builds.current) setBuilding(null);
    }
  }

  useEffect(() => {
    void build();
  }, [props.projectId, props.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ __studio: 1, ...msg }, "*");
  const deck = (cmd: string, extra: Record<string, unknown> = {}) => send({ type: "deck", cmd, ...extra });

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== frame.current?.contentWindow || !e.data?.__studio) return;
      const d = e.data as Record<string, unknown> & { type: string };
      if (d.type === "deck.ready") {
        setDeckSlides((d.slides as DeckSlide[]) ?? []);
        if (thumbsFor.current !== props.revision) {
          thumbsFor.current = props.revision;
          void studio.build
            .thumbnails(props.projectId)
            .then(() => props.onThumbnails?.())
            .catch(() => {});
        }
      } else if (d.type === "deck.state") {
        const p = d as unknown as DeckPosition;
        setPos(p);
        if (p.slide && p.slide !== props.activeSlide?.id) props.onActiveSlide(p.slide);
      } else if (d.type === "console" && (d.level === "error" || d.level === "warn")) {
        const line = { level: String(d.level), text: String(d.text ?? "") };
        setConsoleLines((ls) => (ls.some((l) => l.text === line.text) ? ls : [...ls, line].slice(-50)));
      } else if (d.type === "select" && d.part) {
        const p = posRef.current;
        props.onSelect(String(d.part), { tag: d.tag as string | undefined, text: d.text as string | undefined, slide: p?.slide, step: p?.step });
        setPicking(false);
      } else if (d.type === "ready") {
        send({ type: "pick", on: picking });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  useEffect(() => send({ type: "pick", on: picking }), [picking]); // eslint-disable-line react-hooks/exhaustive-deps

  // Picking a slide elsewhere (storyboard, chat) jumps there.
  useEffect(() => {
    const id = props.activeSlide?.id;
    if (id && pos && pos.slide !== id) deck("goto", { slide: id, step: 0, play: true });
  }, [props.activeSlide?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arrow keys step through the deck when the app (not a text field) has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || t?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") deck("next");
      else if (e.key === "ArrowLeft" || e.key === "PageUp") deck("prev");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const current = deckSlides.find((s) => s.id === pos?.slide);
  const errorCount = consoleLines.filter((l) => l.level === "error").length;
  const vertical = props.aspect === "vertical";

  return (
    <div className="grid h-full min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-2.5 overflow-hidden px-4 pb-3 pt-3">
      <div className="@container/stagebar flex min-w-0 items-center gap-2">
        {props.leading}
        <div className="flex flex-none items-center gap-0.5 rounded-[9px] border border-line bg-surface p-0.5">
          <button className="icon-btn h-7 w-7" title="Previous step (←)" onClick={() => deck("prev")} disabled={!pos}>
            <Prev size={15} />
          </button>
          <span className="min-w-[92px] px-1 text-center font-mono text-[11.5px] tabular-nums text-ink-2" aria-live="polite">
            {pos ? `${pos.index + 1}/${deckSlides.length} · step ${pos.step + 1}/${pos.steps}` : "–"}
          </span>
          <button className="icon-btn h-7 w-7" title="Next step (→)" onClick={() => deck("next")} disabled={!pos}>
            <Next size={15} />
          </button>
        </div>
        <button
          className="btn btn-sm flex-none"
          style={picking ? { background: "var(--color-accent-soft)", borderColor: "var(--color-accent)", color: "var(--color-accent-ink)" } : undefined}
          onClick={() => setPicking((v) => !v)}
          title="Click a part of a slide to change it"
        >
          <Cursor size={14} /> {picking ? "Click a part…" : "Select"}
        </button>
        {props.selection && (
          <span className="chip flex min-w-0 items-center gap-1.5 bg-[#FFF7D1] text-[#7A6200] dark:bg-[#3a3214] dark:text-[#ffe14d]">
            <span className="truncate">{props.selection.part}</span>
            <button onClick={() => props.onSelect(null)} className="opacity-60 hover:opacity-100" aria-label="Clear selection">
              ✕
            </button>
          </span>
        )}
        <span className="flex-1" />
        <StatusNote working={building} builtAt={builtAt} failed={errors.length > 0} />
        {consoleLines.length > 0 && (
          <button
            className="tag flex-none"
            style={errorCount ? { background: "var(--color-bad-soft)", color: "var(--color-bad)" } : { background: "var(--color-warn-soft)", color: "var(--color-warn)" }}
            onClick={() => setShowConsole((v) => !v)}
          >
            {errorCount ? `${errorCount} error${errorCount > 1 ? "s" : ""}` : `${consoleLines.length} warning${consoleLines.length > 1 ? "s" : ""}`}
          </button>
        )}
        <button className="icon-btn flex-none" title="Rebuild the slides" onClick={() => void build()} disabled={Boolean(building)}>
          <Refresh size={15} />
        </button>
        <button
          className="btn btn-sm flex-none"
          disabled={!url || !deckSlides.length}
          title="Present the slides"
          onClick={() => {
            if (props.onPresent) props.onPresent(pos, deckSlides);
            else void frameBox.current?.requestFullscreen().then(() => frame.current?.focus());
          }}
        >
          <Present size={15} /> Present
        </button>
      </div>

      <StageFrame
        aspect={props.aspect}
        frameRef={frameBox}
        agentView={{
          project: props.projectId,
          view: `slides, step ${pos ? pos.step + 1 : 1} of ${pos?.steps ?? 1}`,
          scene: current?.title ?? props.activeSlide?.title ?? "",
          time: pos?.step ?? 0,
          total: pos?.position ?? 0,
          playing: Boolean(pos?.playing),
        }}
      >
        {url ? (
          <iframe ref={frame} key={url} src={url} title="Slides" sandbox="allow-scripts allow-pointer-lock" allow="fullscreen" className="h-full w-full border-0" />
        ) : (
          <div className="grid h-full place-items-center p-8 text-center text-white/70">
            {props.busy || building ? (
              <div className="flex flex-col items-center gap-3">
                <div className="spinner" />
                <span>{props.busy ? "The assistant is making your slides…" : building}</span>
              </div>
            ) : errors.length ? null : (
              "Slides appear here once the assistant writes them."
            )}
          </div>
        )}
        {(errors.length > 0 || warnings.length > 0) && (
          <div className={`absolute inset-x-3 top-3 max-h-[60%] overflow-auto rounded-xl p-3 font-mono text-[11.5px] shadow-1 animate-in ${errors.length ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>
            <b className="mb-1 block font-sans text-[12.5px]">{errors.length ? "The slides could not be built" : "Some slides need a fix"}</b>
            {[...errors, ...warnings].map((e, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {e}
              </div>
            ))}
            <div className="mt-2 font-sans text-[12px] text-ink-2">Ask the assistant to fix it. It sees the same errors.</div>
          </div>
        )}
        {showConsole && (
          <div className="absolute inset-x-3 bottom-3 max-h-40 overflow-auto rounded-lg bg-surface p-2 font-mono text-[11px] text-ink-2 shadow-1">
            {consoleLines.map((l, i) => (
              <div key={i} className={l.level === "error" ? "text-bad" : "text-warn"}>
                [{l.level}] {l.text}
              </div>
            ))}
          </div>
        )}
      </StageFrame>

      <Filmstrip
        slides={props.slides}
        deckSlides={deckSlides}
        pos={pos}
        vertical={vertical}
        onGoto={(id, step, play) => deck("goto", { slide: id, step, play })}
        busy={props.busy}
      />
    </div>
  );
}

/** Every slide as a picture, with one dot per step; the current step is filled in. */
function Filmstrip(props: { slides: SceneMeta[]; deckSlides: DeckSlide[]; pos: DeckPosition | null; vertical: boolean; busy: boolean; onGoto: (id: string, step: number, play: boolean) => void }) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>("[data-current=true]");
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [props.pos?.slide]);
  if (!props.slides.length) return <div className="h-[86px] rounded-xl border border-dashed border-line text-center text-[12.5px] leading-[86px] text-muted">{props.busy ? "The assistant is making the slides…" : "No slides yet."}</div>;
  return (
    <div ref={strip} className="flex gap-2 overflow-x-auto pb-1" role="listbox" aria-label="Slides">
      {props.slides.map((s, i) => {
        const d = props.deckSlides.find((x) => x.id === s.id);
        const on = props.pos?.slide === s.id;
        const steps = d?.steps ?? 1;
        return (
          <button
            key={s.id}
            role="option"
            aria-selected={on}
            data-current={on}
            title={`${i + 1}. ${s.title}${d?.type === "html" ? " (HTML)" : d?.type === "animation" ? " (animated)" : ""}`}
            onClick={() => props.onGoto(s.id, 0, true)}
            className={`group flex flex-none flex-col gap-1 rounded-[10px] p-1 text-left transition-colors ${on ? "bg-accent-soft" : "hover:bg-surface-2"}`}
          >
            <span
              className={`relative block overflow-hidden rounded-[7px] bg-stage bg-cover bg-center ring-1 ${on ? "ring-2 ring-accent" : "ring-line"} ${props.vertical ? "h-[72px] w-[40px]" : "h-[56px] w-[100px]"}`}
              style={s.thumbUrl ? { backgroundImage: `url("${s.thumbUrl}")` } : undefined}
            >
              <i className="absolute left-1 top-0.5 not-italic font-mono text-[10px] font-semibold text-white [text-shadow:0_1px_3px_#000]">{i + 1}</i>
              {s.slideType === "animation" && <i className="absolute bottom-0.5 right-1 not-italic text-[9px] text-white/80 [text-shadow:0_1px_3px_#000]">▶</i>}
            </span>
            <span className="flex h-[6px] items-center gap-[3px] px-0.5">
              {Array.from({ length: Math.min(steps, 12) }, (_, k) => (
                <i
                  key={k}
                  role="presentation"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onGoto(s.id, k, false);
                  }}
                  className="block h-[5px] flex-1 rounded-full"
                  style={{ background: on && props.pos && k <= props.pos.step ? "var(--color-accent)" : "var(--color-line)", minWidth: 4 }}
                />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}
