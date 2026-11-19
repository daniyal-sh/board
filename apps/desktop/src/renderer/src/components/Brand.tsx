import { BRAND } from "@studio/shared";

const ORBIT =
  "M40 352 C6 378 -8 438 22 468 C48 490 96 478 150 458 C185 453 224 442 288 421 C337 402 382 384 424 365 C468 343 507 325 540 310 C585 272 628 248 656 216 C678 190 686 168 662 152 C640 138 600 148 548 168";

/**
 * The Apollo Board mark: Apollo's A, orbit and planet drawn on a board. Strokes follow the theme
 * (graphite / near-white), the orbit is indigo and the planet is Apollo's assistant blue.
 */
export function BoardMark(props: { size?: number; className?: string }) {
  const h = props.size ?? 24;
  return (
    <svg width={(h * 780) / 640} height={h} viewBox="-40 -40 780 640" fill="none" aria-hidden className={props.className}>
      <rect x="-6" y="-14" width="712" height="540" rx="70" stroke="var(--color-ink)" strokeWidth="26" opacity=".9" />
      <path d="M250 580 L450 580" stroke="var(--color-ink)" strokeWidth="26" strokeLinecap="round" />
      <path d={ORBIT} stroke="var(--color-accent)" strokeWidth="30" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M174 395 L335 22 L442 268" stroke="var(--color-ink)" strokeWidth="32" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M508 422 L532 486" stroke="var(--color-ink)" strokeWidth="28" strokeLinecap="round" />
      <circle cx="552" cy="298" r="46" fill="var(--color-assistant)" />
    </svg>
  );
}

/** "Apollo Board" with the mark; `byline` adds "by the Apollo team". */
export function Lockup(props: { size?: number; byline?: boolean }) {
  const s = props.size ?? 18;
  const [first, ...rest] = BRAND.name.split(" ");
  return (
    <span className="inline-flex items-center" style={{ gap: s * 0.45 }} aria-label={BRAND.name}>
      <BoardMark size={s * 1.3} />
      <span className="whitespace-nowrap font-semibold tracking-[-0.02em]" style={{ fontSize: s * 0.9 }}>
        {first} <span className="font-medium text-accent-ink">{rest.join(" ")}</span>
      </span>
      {props.byline && <span className="whitespace-nowrap text-muted" style={{ fontSize: s * 0.6 }}>{BRAND.byline}</span>}
    </span>
  );
}
