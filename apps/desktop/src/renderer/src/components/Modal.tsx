import { useEffect } from "react";
import { Close } from "./Icons";

export function Modal(props: { title: string; onClose: () => void; width?: number; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(23,23,28,.32)] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div role="dialog" aria-label={props.title} className="max-h-[88vh] overflow-auto rounded-[18px] bg-surface p-5 shadow-[0_30px_80px_-20px_rgba(0,0,0,.5)] animate-in" style={{ width: props.width ?? 520 }}>
        <div className="mb-3.5 flex items-center">
          <h3 className="serif m-0 text-[26px]">{props.title}</h3>
          <span className="flex-1" />
          <button className="icon-btn" onClick={props.onClose} aria-label="Close">
            <Close />
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
