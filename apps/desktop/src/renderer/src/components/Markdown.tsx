import { Fragment } from "react";

/**
 * Just enough markdown for assistant replies: paragraphs, bullet and numbered lists,
 * **bold**, *italic*, `code` and headings. Rendered as React elements, never as HTML.
 */
function inline(text: string, key: string) {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("**")) out.push(<b key={k} className="font-semibold text-ink">{t.slice(2, -2)}</b>);
    else if (t.startsWith("`")) out.push(<code key={k} className="rounded bg-black/5 px-1 font-mono text-[12px]">{t.slice(1, -1)}</code>);
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const items: { text: string; depth: number }[] = [];
      while (i < lines.length && (bullet.test(lines[i]) || numbered.test(lines[i]))) {
        const depth = (/^\s*/.exec(lines[i])?.[0].length ?? 0) >= 2 ? 1 : 0;
        items.push({ text: lines[i].replace(ordered ? numbered : bullet, "").replace(bullet, ""), depth });
        i++;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={n++} className={`my-1.5 pl-5 ${ordered ? "list-decimal" : "list-disc"} marker:text-faint`}>
          {items.map((it, k) => (
            <li key={k} className={it.depth ? "ml-4" : ""}>
              {inline(it.text, `${n}-${k}`)}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<p key={n++} className="mb-1 mt-2 font-semibold text-ink">{inline(heading[1], `h${n}`)}</p>);
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !bullet.test(lines[i]) && !numbered.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={n++} className="my-1.5">
        {para.map((l, k) => (
          <Fragment key={k}>
            {k > 0 && " "}
            {inline(l, `p${n}-${k}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="[&>*:first-child]:mt-0">{blocks}</div>;
}
