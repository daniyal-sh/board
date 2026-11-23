import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A narration script shown like a document: {{mark:name}} cues appear as small amber chips.
 * Click to edit in place (cues stay as chips you can cut, paste or delete). While the voice
 * plays, the sentence being spoken is highlighted.
 */

const MARK = /\{\{\s*mark\s*:\s*([\w-]+)\s*\}\}/g;

/** Leading headings and comments are kept as they are and not shown. */
function splitHead(src: string): { head: string; body: string } {
  const lines = src.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (/^\s*#/.test(lines[i]) || /^\s*<!--.*-->\s*$/.test(lines[i]) || !lines[i].trim())) i++;
  return { head: lines.slice(0, i).join("\n").replace(/\s+$/, ""), body: lines.slice(i).join("\n").replace(/\s+$/, "") };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const chipHtml = (name: string) => `<span contenteditable="false" data-mark="${esc(name)}" class="cue-chip">${esc(name)}</span>`;

function toHtml(body: string): string {
  let out = "";
  let last = 0;
  for (const m of body.matchAll(MARK)) {
    out += esc(body.slice(last, m.index));
    out += chipHtml(m[1]);
    last = m.index! + m[0].length;
  }
  return out + esc(body.slice(last));
}

function serialize(el: HTMLElement): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? "";
    else if (n instanceof HTMLElement) {
      if (n.dataset.mark) out += `{{mark:${n.dataset.mark}}}`;
      else if (n.tagName === "BR") out += "\n";
      else {
        const block = n.tagName === "DIV" || n.tagName === "P";
        if (block && out && !out.endsWith("\n")) out += "\n";
        n.childNodes.forEach(walk);
      }
    }
  };
  el.childNodes.forEach(walk);
  return out.replace(/ /g, " ");
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The body split into sentences (with their cues) for display and highlighting. */
function sentencesOf(body: string): { parts: (string | { mark: string })[]; plain: string }[] {
  const tokens: (string | { mark: string })[] = [];
  let last = 0;
  for (const m of body.matchAll(MARK)) {
    if (m.index! > last) tokens.push(body.slice(last, m.index));
    tokens.push({ mark: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < body.length) tokens.push(body.slice(last));
  const out: { parts: (string | { mark: string })[]; plain: string }[] = [];
  let cur: (string | { mark: string })[] = [];
  let plain = "";
  const flush = () => {
    if (cur.length) out.push({ parts: cur, plain });
    cur = [];
    plain = "";
  };
  for (const t of tokens) {
    if (typeof t !== "string") {
      cur.push(t);
      continue;
    }
    // Break after sentence ends, keeping the punctuation and following space with the sentence.
    const pieces = t.split(/(?<=[.!?]["')\]]?\s+)/);
    pieces.forEach((p, i) => {
      cur.push(p);
      plain += p;
      if (i < pieces.length - 1) flush();
    });
  }
  flush();
  return out;
}

export function ScriptText(props: {
  value: string;
  onSave: (text: string) => void;
  /** Caption being spoken right now (highlighted), if the voice is playing this scene. */
  speaking?: string;
  placeholder?: string;
  /** Register a function that inserts a cue at the caret. */
  editorRef?: React.MutableRefObject<{ insertCue: () => void; focus: () => void } | null>;
  large?: boolean;
}) {
  const { head, body } = splitHead(props.value);
  const [editing, setEditing] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  const lastBody = useRef(body);

  useLayoutEffect(() => {
    if (!editing || !el.current) return;
    el.current.innerHTML = toHtml(body);
    lastBody.current = body;
    el.current.focus();
    // Caret at the end.
    const r = document.createRange();
    r.selectNodeContents(el.current);
    r.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  function commit() {
    if (!el.current) return;
    const next = serialize(el.current).replace(/[ \t]+\n/g, "\n").trim();
    setEditing(false);
    if (next === lastBody.current.trim()) return;
    // The script changed underneath (the assistant rewrote it): don't silently undo that.
    if (body.trim() !== lastBody.current.trim() && !window.confirm("The assistant changed this script while you were editing it. Replace its version with yours?")) return;
    props.onSave((head ? head + "\n\n" : "") + next + "\n");
  }

  function insertCue() {
    if (!editing) {
      setEditing(true);
      requestAnimationFrame(() => insertCueNow());
      return;
    }
    insertCueNow();
  }
  function insertCueNow() {
    const host = el.current;
    if (!host) return;
    const used = new Set([...serialize(host).matchAll(MARK)].map((m) => m[1]));
    let n = 1;
    while (used.has(`cue${n}`)) n++;
    host.focus();
    document.execCommand("insertHTML", false, `${chipHtml(`cue${n}`)}&nbsp;`);
  }

  useEffect(() => {
    if (props.editorRef) props.editorRef.current = { insertCue, focus: () => setEditing(true) };
  });

  const size = props.large ? "text-[17px] leading-[1.75]" : "text-[15px] leading-[1.7]";

  if (editing)
    return (
      <div
        ref={el}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        className={`script-text min-h-[3em] whitespace-pre-wrap rounded-lg px-2 py-1 text-ink outline-none ring-2 ring-accent/40 ${size}`}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            (e.target as HTMLElement).blur();
          } else if (e.key === "Enter") {
            e.preventDefault();
            document.execCommand("insertText", false, "\n");
          } else if ((e.key === "m" || e.key === "M") && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            insertCueNow();
          } else if (e.key === "{") {
            e.preventDefault();
            insertCueNow();
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
      />
    );

  const sentences = sentencesOf(body);
  const speaking = props.speaking ? norm(props.speaking) : "";
  const active = speaking
    ? sentences.findIndex((s) => {
        const p = norm(s.plain);
        return p && (p.includes(speaking) || speaking.includes(p));
      })
    : -1;

  return (
    <div
      role="textbox"
      tabIndex={0}
      title="Click to edit"
      onClick={() => setEditing(true)}
      onKeyDown={(e) => e.key === "Enter" && setEditing(true)}
      className={`script-text cursor-text whitespace-pre-wrap rounded-lg px-2 py-1 text-ink hover:bg-surface-2 ${size}`}
    >
      {body.trim() ? (
        sentences.map((s, i) => (
          <span key={i} className={i === active ? "rounded bg-accent-soft text-accent-ink shadow-[0_0_0_2px_var(--color-accent-soft)]" : active >= 0 && i < active ? "text-muted" : ""}>
            {s.parts.map((p, j) => (typeof p === "string" ? <span key={j}>{p}</span> : <span key={j} className="cue-chip">{p.mark}</span>))}
          </span>
        ))
      ) : (
        <span className="text-faint">{props.placeholder ?? "Write what the narrator says…"}</span>
      )}
    </div>
  );
}
