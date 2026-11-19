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

  async function run(label: string, fn: () => Promise<string | null>) {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      setNote(await fn());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
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
        {m.kind !== "lab" && (
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
        {m.kind !== "video" && (
          <>
            <Row
              icon="HTML"
              title="Single HTML file"
              hint="Everything inlined. Opens offline in any browser; upload it to your LMS or send it to students."
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
