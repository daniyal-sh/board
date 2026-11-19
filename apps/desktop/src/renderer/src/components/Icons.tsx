import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...p }: P, children: React.ReactNode, strokeWidth = 1.9) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...p}>
      {children}
    </svg>
  );
}

export const HomeIcon = (p: P) => base(p, <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />);
export const GearIcon = (p: P) =>
  base(p, <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>);
export const ArrowRight = (p: P) => base(p, <path d="M5 12h14M13 6l6 6-6 6" />, 2.2);
export const ArrowUp = (p: P) => base(p, <path d="M12 19V5M5 12l7-7 7 7" />, 2.4);
export const Paperclip = (p: P) => base(p, <path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />);
export const Close = (p: P) => base(p, <path d="M6 6l12 12M18 6L6 18" />, 2);
export const Refresh = (p: P) => base(p, <><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" /><path d="M3 21v-5h5" /></>);
export const History = (p: P) => base(p, <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>);
export const Undo = (p: P) => base(p, <><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>);
export const Cursor = (p: P) => base(p, <path d="M5 3l14 7-6 2-2 6z" />);
export const Stop = (p: P) => <svg width={p.size ?? 12} height={p.size ?? 12} viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" /></svg>;
export const Play = (p: P) => <svg width={p.size ?? 12} height={p.size ?? 12} viewBox="0 0 12 12"><path d="M2.5 1l8 5-8 5z" fill="currentColor" /></svg>;
export const Pause = (p: P) => <svg width={p.size ?? 12} height={p.size ?? 12} viewBox="0 0 12 12"><rect x="2" y="1" width="3" height="10" rx="1" fill="currentColor" /><rect x="7" y="1" width="3" height="10" rx="1" fill="currentColor" /></svg>;
export const Phone = (p: P) => base(p, <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></>);
export const Desktop = (p: P) => base(p, <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>);
export const Check = (p: P) => base(p, <path d="M5 12l5 5 9-10" />, 2.4);
export const Trash = (p: P) => base(p, <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>);
export const Download = (p: P) => base(p, <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></>);
export const Link = (p: P) => base(p, <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />);
export const Lock = (p: P) => base(p, <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>);
export const Globe = (p: P) => base(p, <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>);
export const Folder = (p: P) => base(p, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);

/** Small dark tiles used for the three project kinds. */
export function KindGlyph({ kind, size = 22 }: { kind: "video" | "web" | "lab"; size?: number }) {
  if (kind === "video")
    return <svg width={size} height={size} viewBox="0 0 24 24"><path d="M3 18 C7 4 11 6 14 13 S20 15 22 6" fill="none" stroke="#58C4DD" strokeWidth="2" /></svg>;
  if (kind === "web")
    return <svg width={size} height={size} viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="#FFE14D" strokeWidth="2" /><path d="M12 12l5-3" stroke="#F26B5B" strokeWidth="2" /></svg>;
  return <svg width={size} height={size} viewBox="0 0 24 24"><rect x="3" y="15" width="18" height="2" rx="1" fill="#666" /><circle cx="14" cy="16" r="3" fill="#5DB37A" /><path d="M4 11 Q12 0 20 11" fill="none" stroke="#5DB37A" strokeWidth="2" /></svg>;
}
