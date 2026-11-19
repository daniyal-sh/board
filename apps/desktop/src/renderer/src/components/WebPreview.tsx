import { useEffect, useRef, useState } from "react";
import type { Selection } from "@studio/shared";
import { errorMessage, formatBytes, studio } from "../lib/api";
import { Cursor, Desktop, Download, Phone, Refresh } from "./Icons";

interface ConsoleLine {
  level: string;
  text: string;
}

const LIB_LABEL: Record<string, string> = {
  katex: "KaTeX",
  jsxgraph: "JSXGraph",
  d3: "D3",
  "@observablehq/plot": "Plot",
  three: "Three.js",
  "matter-js": "Matter.js",
  gsap: "GSAP",
  "manim-web": "manim-web",
};

export function WebPreview(props: {
  projectId: string;
  revision: number;
  busy: boolean;
  selection: Selection | null;
  onSelect: (part: string | null, info?: { tag?: string; text?: string }) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [size, setSize] = useState<number | null>(null);
  const [libs, setLibs] = useState<string[]>([]);
  const [building, setBuilding] = useState(false);
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [picking, setPicking] = useState(false);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [showConsole, setShowConsole] = useState(false);

  async function build() {
    setBuilding(true);
    try {
      const r = await studio.build.preview(props.projectId);
      setErrors(r.errors);
      if (r.ok && r.previewUrl) {
        setConsoleLines([]);
        setUrl(r.previewUrl);
        setSize(r.sizeBytes ?? null);
        setLibs(r.libraries ?? []);
      }
    } catch (e) {
      setErrors([errorMessage(e)]);
    } finally {
      setBuilding(false);
    }
  }

  useEffect(() => {
    void build();
  }, [props.projectId, props.revision]);

  // Messages from the preview bridge.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== frame.current?.contentWindow || !e.data?.__studio) return;
      const d = e.data as { type: string; level?: string; text?: string; part?: string; tag?: string };
      if (d.type === "console" && (d.level === "error" || d.level === "warn")) {
        setConsoleLines((ls) => (ls.some((l) => l.text === d.text) ? ls : [...ls, { level: d.level!, text: d.text ?? "" }].slice(-50)));
      } else if (d.type === "select" && d.part) {
        props.onSelect(d.part, { tag: d.tag, text: d.text });
        setPicking(false);
      } else if (d.type === "ready") {
        postPick(picking);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  function postPick(on: boolean) {
    frame.current?.contentWindow?.postMessage({ __studio: 1, type: "pick", on }, "*");
  }
  useEffect(() => postPick(picking), [picking]);

  const errorCount = consoleLines.filter((l) => l.level === "error").length;
  const isLab = true;

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto] gap-3 px-[18px] py-4">
      <div className="flex items-center gap-2">
        <button
          className="btn btn-sm"
          data-on={picking}
          style={picking ? { background: "var(--color-accent)", color: "#fff" } : undefined}
          onClick={() => setPicking((v) => !v)}
          title="Click a part of the page to change it"
        >
          <Cursor size={14} /> {picking ? "Click a part…" : "Select"}
        </button>
        {props.selection && (
          <span className="chip flex items-center gap-1.5 bg-[#FFF7D1] text-[#7A6200]">
            {props.selection.part}
            <button onClick={() => props.onSelect(null)} className="opacity-60 hover:opacity-100">
              ✕
            </button>
          </span>
        )}
        <span className="flex-1" />
        {building && <span className="spinner" />}
        {isLab && (
          <div className="seg">
            <button data-on={device === "desktop"} onClick={() => setDevice("desktop")} title="Desktop">
              <Desktop size={14} />
            </button>
            <button data-on={device === "phone"} onClick={() => setDevice("phone")} title="Phone">
              <Phone size={14} />
            </button>
          </div>
        )}
        <button className="icon-btn" title="Rebuild preview" onClick={() => void build()}>
          <Refresh size={15} />
        </button>
      </div>

      <div className="flex min-h-0 justify-center">
        <div
          className="relative h-full overflow-hidden rounded-[14px] shadow-2 transition-[width] duration-300"
          style={{
            width: isLab ? (device === "phone" ? 390 : "100%") : "100%",
            maxWidth: isLab ? undefined : "calc((100vh - 220px) * 16 / 9)",
            aspectRatio: isLab ? undefined : "16 / 9",
            height: isLab ? "100%" : "auto",
            alignSelf: isLab ? undefined : "center",
            background: isLab ? "#fff" : "var(--color-stage)",
          }}
        >
          {url ? (
            <iframe
              ref={frame}
              key={url}
              src={url}
              title="Preview"
              sandbox="allow-scripts allow-pointer-lock"
              className="h-full w-full border-0"
            />
          ) : (
            <div className="grid h-full place-items-center p-8 text-center text-muted">
              {props.busy || building ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="spinner" />
                  <span>The assistant is building your {isLab ? "Lab" : "animation"}…</span>
                </div>
              ) : errors.length ? null : (
                "Nothing to preview yet."
              )}
            </div>
          )}
          {errors.length > 0 && (
            <div className="absolute inset-x-3 bottom-3 max-h-[45%] overflow-auto rounded-xl bg-bad-soft p-3 font-mono text-[11.5px] text-bad shadow-1 animate-in">
              <b className="mb-1 block font-sans text-[12.5px]">The preview could not be built</b>
              {errors.map((e, i) => (
                <div key={i} className="whitespace-pre-wrap">
                  {e}
                </div>
              ))}
              <div className="mt-2 font-sans text-[12px] text-ink-2">Ask the assistant to fix it. It sees the same errors.</div>
            </div>
          )}
        </div>
      </div>

      <div className="card flex flex-wrap items-center gap-2 px-3 py-2 text-[12px] text-muted">
        <b className="mr-1 text-[12.5px] font-semibold text-ink">Built with</b>
        {libs.length ? (
          libs.map((l) => (
            <span key={l} className="rounded-full bg-surface-2 px-2.5 py-0.5 font-medium text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
              {LIB_LABEL[l] ?? l}
            </span>
          ))
        ) : (
          <span>{isLab ? "plain HTML + lab kit" : "manim-web"}</span>
        )}
        {consoleLines.length > 0 && (
          <button className="ml-2 rounded-full bg-bad-soft px-2.5 py-0.5 font-medium text-bad" onClick={() => setShowConsole((v) => !v)}>
            {errorCount ? `${errorCount} error${errorCount > 1 ? "s" : ""}` : `${consoleLines.length} warning${consoleLines.length > 1 ? "s" : ""}`}
          </button>
        )}
        <span className="flex-1" />
        {size !== null && <span className="font-mono">one file · {formatBytes(size)} · works offline</span>}
        <button className="btn btn-ghost btn-sm" onClick={() => void studio.build.exportHtml(props.projectId)}>
          <Download size={14} /> .html
        </button>
        {showConsole && (
          <div className="mt-1 w-full max-h-40 overflow-auto rounded-lg bg-surface-2 p-2 font-mono text-[11px] text-ink-2">
            {consoleLines.map((l, i) => (
              <div key={i} className={l.level === "error" ? "text-bad" : "text-warn"}>
                [{l.level}] {l.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
