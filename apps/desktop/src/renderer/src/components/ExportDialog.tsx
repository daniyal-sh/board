import { useState } from "react";
import type { ProjectManifest } from "@studio/shared";
import { errorMessage, formatBytes, studio } from "../lib/api";
import { Modal } from "./Modal";
import { Copy, Download, Folder, Trash } from "./Icons";

/** Everything stays on this computer: files to save, HTML to paste, the project folder. */
export function ExportDialog(props: { manifest: ProjectManifest; onClose: () => void; onDeleted: () => void }) {
  const m = props.manifest;
  const vertical = m.aspect === "vertical";
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [perSlide, setPerSlide] = useState(false);

  async function run(label: string, fn: () => Promise<string | null>) {
    setBusy(label);
    setError(null);
    setNote(null);
    const off = studio.video.onProgress(setProgress);
    try {
      setNote(await fn());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      off();
      setProgress(null);
      setBusy(null);
    }
  }
  const slides = m.kind === "slides";
  const saved = (r: { path: string } | null) => (r ? `Saved to ${r.path}` : null);

  return (
    <Modal title="Export" onClose={props.onClose} width={540}>
      <div className="grid gap-2">
        {m.kind === "video" && (
          <Row
            icon="MP4"
            title="Video"
            hint={`${vertical ? "1080×1920 vertical" : "1080p"}, every scene in high quality, with captions (.srt) beside it`}
            action={busy === "mp4" ? "Rendering…" : "Export"}
            disabled={!!busy}
            onClick={() => run("mp4", async () => saved(await studio.video.exportMp4(m.id)))}
          />
        )}
        {m.kind !== "lab" && m.kind !== "slides" && (
          <Row
            icon="GIF"
            title="Looping GIF"
            hint={`For slides, LMS pages and chats. ${vertical ? "360 px wide, 9:16" : "640 px wide"}, 15 fps, no sound`}
            action={busy === "gif" ? "Making…" : "Export"}
            disabled={!!busy}
            onClick={() =>
              run("gif", async () => {
                const r = await studio.video.exportGif(m.id);
                return r ? `Saved ${formatBytes(r.sizeBytes)} to ${r.path}` : null;
              })
            }
          />
        )}
        {slides && (
          <>
            <Row
              icon="HTML"
              title="Slides as a web page"
              hint="Present from any browser, offline: arrow keys, pen and laser, and a speaker view (S). Large Manim clips are saved in a folder next to it."
              action={busy === "html" ? "Saving…" : "Save"}
              disabled={!!busy}
              onClick={() =>
                run("html", async () => {
                  const r = await studio.build.exportHtml(m.id);
                  return r ? `Saved to ${r.path}${r.folder ? `, with the clips in ${r.folder}. Keep them together.` : ""}` : null;
                })
              }
            />
            <Row
              icon="PDF"
              title="PDF"
              hint={`${perSlide ? "One page per slide (its last step)" : "One page per step"}, for handouts and printing`}
              action={busy === "pdf" ? "Making…" : "Export"}
              disabled={!!busy}
              onClick={() =>
                run("pdf", async () => {
                  const r = await studio.build.exportDeck(m.id, "pdf", { perSlide });
                  return r ? `Saved ${r.count} pages to ${r.path}` : null;
                })
              }
            />
            <Row
              icon="PPTX"
              title="PowerPoint"
              hint={`${perSlide ? "One slide per slide" : "One slide per step"}, as pictures, with your speaker notes. Opens in PowerPoint, Keynote and Google Slides.`}
              action={busy === "pptx" ? "Making…" : "Export"}
              disabled={!!busy}
              onClick={() =>
                run("pptx", async () => {
                  const r = await studio.build.exportDeck(m.id, "pptx", { perSlide });
                  return r ? `Saved ${r.count} slides to ${r.path}` : null;
                })
              }
            />
            <label className="flex items-center gap-2 px-1 py-1 text-[12.5px] text-muted">
              <input type="checkbox" checked={perSlide} onChange={(e) => setPerSlide(e.target.checked)} />
              PDF and PowerPoint: only the finished slide, not every step
            </label>
          </>
        )}
        {m.kind !== "video" && !slides && (
          <>
            <Row
              icon="HTML"
              title="Single HTML file"
              hint={
                m.kind === "slides"
                  ? "The whole deck in one file. Opens offline in any browser; present it with the arrow keys or share it with students."
                  : "Everything inlined. Opens offline in any browser; upload it to your LMS or send it to students."
              }
              action="Save"
              disabled={!!busy}
              onClick={() => run("html", async () => saved(await studio.build.exportHtml(m.id)))}
            />
            <Row
              icon={<Copy size={15} />}
              title="Copy the HTML"
              hint="For sites that accept raw HTML: Google Sites embed code, WordPress Custom HTML, Squarespace."
              action={busy === "copy" ? "Building…" : "Copy"}
              disabled={!!busy}
              onClick={() =>
                run("copy", async () => {
                  const r = await studio.build.copyHtml(m.id);
                  return `Copied ${formatBytes(r.sizeBytes)} of HTML.`;
                })
              }
            />
          </>
        )}
        <Row
          icon={<Folder size={15} />}
          title="Project folder"
          hint="The source files, for editing by hand or backing up"
          action="Show"
          onClick={() => void studio.projects.open(m.id).then((p) => studio.app.showInFolder(`${p.dir}/project.json`))}
        />
      </div>

      {progress && busy && (
        <div className="mt-3 flex items-center gap-2 text-[12.5px] text-muted">
          <span className="spinner" /> {progress}
        </div>
      )}
      {note && <div className="mt-3 rounded-lg border border-good-line bg-good-soft px-3 py-2 text-[13px] text-good">{note}</div>}
      {error && <div className="mt-3 whitespace-pre-wrap rounded-lg border border-bad-line bg-bad-soft px-3 py-2 text-[13px] text-bad">{error}</div>}

      <div className="mt-5 flex border-t border-line pt-3">
        <span className="flex-1" />
        <button
          className="btn btn-ghost btn-sm text-bad"
          onClick={async () => {
            if (!confirm(`Delete "${m.title}" from this computer? This can't be undone.`)) return;
            await studio.projects.remove(m.id);
            props.onClose();
            props.onDeleted();
          }}
        >
          <Trash size={14} /> Delete project
        </button>
      </div>
    </Modal>
  );
}

function Row(props: { icon: React.ReactNode; title: string; hint: string; action: string; disabled?: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line p-3">
      <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-surface-2 font-mono text-[10px] font-semibold text-ink-2">{props.icon}</span>
      <div className="min-w-0 flex-1">
        <b className="block font-semibold">{props.title}</b>
        <small className="text-[12.5px] text-muted">{props.hint}</small>
      </div>
      <button className="btn btn-sm" disabled={props.disabled} onClick={props.onClick}>
        {(props.action === "Export" || props.action === "Save") && <Download size={13} />}
        {props.action}
      </button>
    </div>
  );
}
