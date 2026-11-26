/**
 * Layout checks for videos and web animations: the assistant gets problems in words
 * ("label overlaps radius from 2.4 to 3.1 s") instead of having to spot them in screenshots.
 *
 * Input is a list of snapshots: what was on screen at a moment, with each object's box in
 * frame coordinates (0..1, origin top-left).
 */

export interface LayoutItem {
  name: string;
  /** Mobject class, e.g. "MathTex", "Axes". */
  type: string;
  box: { x0: number; y0: number; x1: number; y1: number };
}

export interface LayoutSnapshot {
  t: number;
  /** Scene the moment belongs to (whole-animation checks). */
  scene?: string;
  items: LayoutItem[];
}

const TEXT_TYPES = /^(Text|MarkupText|Paragraph|Tex|MathTex|SingleStringMathTex|Title|BulletedList|DecimalNumber|Integer|Variable|Code|Typst|MathTexImage|TexText)$/;
/** Things that are meant to sit under or around other objects. */
const BACKDROP_TYPES = /^(Axes|ThreeDAxes|NumberPlane|ComplexPlane|PolarPlane|NumberLine|Rectangle|RoundedRectangle|SurroundingRectangle|BackgroundRectangle|Square|ScreenRectangle|FullScreenRectangle|Table|MathTable|IntegerTable|DecimalTable|ImageMobject|Group|VGroup|Brace|BraceBetweenPoints|Underline|Cross)$/;

const isText = (it: LayoutItem) => TEXT_TYPES.test(it.type);
const area = (b: LayoutItem["box"]) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const inter = (a: LayoutItem["box"], b: LayoutItem["box"]) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const contains = (outer: LayoutItem["box"], inner: LayoutItem["box"], tol = 0.004) =>
  inner.x0 >= outer.x0 - tol && inner.y0 >= outer.y0 - tol && inner.x1 <= outer.x1 + tol && inner.y1 <= outer.y1 + tol;

interface Finding {
  key: string;
  text: (range: string) => string;
  t: number;
  scene?: string;
}

/**
 * @param frameHeightPx rendered height used to describe text size (1080 for 16:9, 1920 for 9:16)
 */
/** `unit: "step"`: snapshot times are slide step indexes (0-based), reported as "step n". */
export function analyseLayout(snaps: LayoutSnapshot[], opts: { frameHeightPx: number; maxFindings?: number; unit?: "s" | "step" } = { frameHeightPx: 1080 }): string[] {
  const found: Finding[] = [];
  for (const s of snaps) {
    const items = s.items.filter((it) => area(it.box) > 0 || isText(it));
    for (const it of items) {
      const b = it.box;
      const edges = [b.x0 < -0.005 && "left", b.x1 > 1.005 && "right", b.y0 < -0.005 && "top", b.y1 > 1.005 && "bottom"].filter(Boolean) as string[];
      if (edges.length) {
        const off = Math.max(-b.x0, b.x1 - 1, -b.y0, b.y1 - 1);
        found.push({ key: `cut:${it.name}:${edges.join()}`, t: s.t, scene: s.scene, text: (r) => `${label(it)} is cut off at the ${edges.join(" and ")} (${Math.round(off * 100)}% outside the frame) ${r}` });
      } else if (isText(it) && (b.x0 < 0.02 || b.x1 > 0.98 || b.y0 < 0.02 || b.y1 > 0.98)) {
        found.push({ key: `edge:${it.name}`, t: s.t, scene: s.scene, text: (r) => `${label(it)} touches the edge of the frame ${r}; leave a margin` });
      }
      if (isText(it)) {
        const px = (b.y1 - b.y0) * opts.frameHeightPx;
        if (px > 0 && px < 26) found.push({ key: `small:${it.name}`, t: s.t, scene: s.scene, text: (r) => `${label(it)} is small (about ${Math.round(px)} px tall at full size) ${r}; it may be hard to read` });
      }
    }
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const c = items[j];
        if (!isText(a) && !isText(c)) continue;
        // A group and its member, or a label in its box, is fine; text inside other text is not.
        if ((contains(a.box, c.box) && !isText(a)) || (contains(c.box, a.box) && !isText(c))) continue;
        const ov = inter(a.box, c.box);
        const smaller = Math.min(area(a.box), area(c.box));
        if (smaller <= 0 || ov / smaller < 0.18) continue;
        // A label on a plot or a shape is usually intentional; only flag it when it covers a lot.
        const backdrop = (!isText(a) && BACKDROP_TYPES.test(a.type)) || (!isText(c) && BACKDROP_TYPES.test(c.type));
        if (backdrop && ov / smaller < 0.5) continue;
        const [p, q] = [a.name, c.name].sort();
        found.push({ key: `over:${p}:${q}`, t: s.t, scene: s.scene, text: (r) => `${label(a)} overlaps ${label(c)} (${Math.round((ov / smaller) * 100)}%) ${r}` });
      }
    }
  }

  // One line per problem, with the time range it lasts for.
  const byKey = new Map<string, Finding[]>();
  for (const f of found) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
  const lines: { t: number; line: string }[] = [];
  for (const group of byKey.values()) {
    const first = group[0];
    const last = group[group.length - 1];
    const where = first.scene ? `in ${first.scene} ` : "";
    const range =
      opts.unit === "step"
        ? group.length === 1 || first.t === last.t
          ? `${where}at step ${first.t + 1}`
          : `${where}from step ${first.t + 1} to ${last.t + 1}`
        : group.length === 1
          ? `${where}at ${first.t.toFixed(1)} s`
          : `${where}from ${first.t.toFixed(1)} to ${last.t.toFixed(1)} s`;
    lines.push({ t: first.t, line: first.text(range) });
  }
  lines.sort((a, b) => a.t - b.t);
  const max = opts.maxFindings ?? 12;
  const out = lines.slice(0, max).map((l) => l.line);
  if (lines.length > max) out.push(`…and ${lines.length - max} more`);
  return out;
}

function label(it: LayoutItem): string {
  return it.name.includes("“") ? it.name : `\`${it.name}\` (${it.type})`;
}

/** Manim timeline (studio_manim) -> snapshots at the end of each recorded step. */
export function snapshotsFromTimeline(tl: { parts: { name: string; type: string; boxes: { t: number; x0: number; y0: number; x1: number; y1: number; o?: number }[] }[] }, scene?: string): LayoutSnapshot[] {
  const times = [...new Set(tl.parts.flatMap((p) => p.boxes.map((b) => b.t)))].sort((a, b) => a - b);
  return times.map((t) => ({
    t,
    scene,
    items: tl.parts.flatMap((p) => {
      const b = p.boxes.find((x) => x.t === t);
      return b && (b.o ?? 1) > 0.05 ? [{ name: p.name, type: p.type, box: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } }] : [];
    }),
  }));
}

export function formatFindings(lines: string[], what: string): string {
  return lines.length ? `Layout checks (${what}):\n${lines.map((l) => `- ${l}`).join("\n")}` : `Layout checks (${what}): no overlaps, cut-off objects or tiny text found.`;
}
