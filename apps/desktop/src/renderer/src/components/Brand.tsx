import { useId } from "react";
import { BRAND } from "@studio/shared";

/*
 * The Board mark: a board on an easel, ringed by Apollo's orbit, with Apollo's planet on the
 * front of the ring. The orbit passes behind the board at the top and in front of it at the
 * bottom. Geometry is generated with build/brand/*.svg (same shapes, theme-aware colours here).
 */
const BACK = "M7.5 57.3L8.0 55.7L8.8 53.9L9.8 52.2L11.2 50.4L12.9 48.5L14.8 46.6L17.0 44.7L19.4 42.8L22.1 40.9L25.1 39.0L28.2 37.2L31.5 35.4L35.0 33.6L38.6 31.9L42.3 30.3L46.2 28.7L50.1 27.3L54.1 25.9L58.2 24.7L62.2 23.5L66.2 22.5L70.2 21.6L74.2 20.9L78.0 20.3L81.7 19.8L85.4 19.4L88.8 19.2L92.1 19.2L95.2 19.3L98.1 19.5L100.8 19.9L103.2 20.5L105.4 21.1L107.3 21.9L108.9 22.9L110.3 23.9";
const FRONT = "M111.2 24.9L112.0 26.3L112.5 27.9L112.6 29.6L112.3 31.4L111.6 33.3L110.5 35.3L109.0 37.4L107.1 39.5L104.9 41.6L102.4 43.8L99.5 46.0L96.3 48.1L92.8 50.2L89.1 52.3L85.2 54.3L81.1 56.2L76.8 58.1L72.4 59.8L67.9 61.4L63.3 62.9L58.7 64.2L54.1 65.4L49.6 66.4L45.1 67.2L40.8 67.9L36.6 68.4L32.6 68.7L28.8 68.8L25.2 68.7L21.9 68.5L18.9 68.0L16.2 67.4L13.8 66.6L11.8 65.6L10.1 64.4L8.8 63.1";
const PLANET = [107.3, 39.3] as const;

export function BoardMark(props: { size?: number; className?: string }) {
  const h = props.size ?? 24;
  const mask = useId();
  return (
    <svg width={(h * 120) / 100} height={h} viewBox="0 0 120 100" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={props.className}>
      <defs>
        <mask id={mask}>
          <rect width="120" height="100" fill="#fff" />
          <rect x="24.5" y="14.5" width="71" height="57" rx="17" fill="#000" />
        </mask>
      </defs>
      <path d={BACK} stroke="var(--color-accent)" strokeWidth="6" mask={`url(#${mask})`} />
      <path d="M47 66 L41 90 M73 66 L79 90" stroke="var(--color-ink)" strokeWidth="6.5" />
      <rect x="30" y="20" width="60" height="46" rx="12" stroke="var(--color-ink)" strokeWidth="7" />
      <path d={FRONT} stroke="var(--color-accent)" strokeWidth="6" />
      <circle cx={PLANET[0]} cy={PLANET[1]} r="7.5" fill="var(--color-assistant)" />
    </svg>
  );
}

/** "Board" with the mark and, optionally, "by Apollo" under it. */
export function Lockup(props: { size?: number; byline?: boolean }) {
  const s = props.size ?? 18;
  return (
    <span className="inline-flex items-center" style={{ gap: s * 0.5 }} aria-label={`${BRAND.name} ${BRAND.byline}`}>
      <BoardMark size={s * 1.55} />
      <span className="flex flex-col leading-none">
        <span className="font-semibold tracking-[-0.02em] text-ink" style={{ fontSize: s * 1.05 }}>
          {BRAND.name}
        </span>
        {props.byline !== false && (
          <span className="font-medium text-muted" style={{ fontSize: s * 0.58, marginTop: s * 0.18 }}>
            {BRAND.byline}
          </span>
        )}
      </span>
    </span>
  );
}
