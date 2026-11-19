import { useEffect, useState } from "react";
import type { Account, ProjectManifest, Visibility } from "@studio/shared";
import { errorMessage, formatBytes, studio } from "../lib/api";
import { Modal } from "./Modal";
import { Download, Globe, Link, Lock, Trash } from "./Icons";

const VIS: { id: Visibility; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: "private", label: "Private", hint: "Only you", icon: <Lock size={15} /> },
  { id: "unlisted", label: "Unlisted", hint: "Anyone with the link", icon: <Link size={15} /> },
  { id: "public", label: "Public", hint: "Listed in the gallery", icon: <Globe size={15} /> },
];

type Tab = "link" | "embed" | "download";

export function ShareDialog(props: { manifest: ProjectManifest; onClose: () => void; onChanged: () => void; onDeleted: () => void }) {
  const m = props.manifest;
  const isVideo = m.kind === "video";
  const [tab, setTab] = useState<Tab>(isVideo ? "download" : "link");
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [visibility, setVisibility] = useState<Visibility>(m.publish?.visibility ?? "unlisted");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [embedMode, setEmbedMode] = useState<"iframe" | "full">(m.publish ? "iframe" : "full");

  useEffect(() => {
    void studio.publish.account().then(setAccount);
  }, []);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const publish = () =>
    run("publish", async () => {
      if (!account) setAccount(await studio.publish.signIn());
      await studio.publish.publish({ projectId: m.id, visibility });
      props.onChanged();
      setNote(m.publish ? "Updated. The link now shows the latest version." : "Published.");
    });

  const iframe = m.publish ? `<iframe src="${m.publish.url.replace("/l/", "/e/")}" width="100%" height="560" style="border:0;border-radius:12px" allow="fullscreen" loading="lazy"></iframe>` : "";

  return (
    <Modal title="Share" onClose={props.onClose} width={540}>
      <div className="mb-4 flex gap-[18px] border-b border-line-2">
        {(["link", "embed", "download"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="-mb-px border-b-2 pb-2 pt-1.5 font-medium"
            style={{ borderColor: tab === t ? "var(--color-ink)" : "transparent", color: tab === t ? "var(--color-ink)" : "var(--color-muted)" }}
          >
            {t === "link" ? "Link" : t === "embed" ? "Embed" : "Download"}
          </button>
        ))}
      </div>

      {tab === "link" &&
        (isVideo ? (
          <p className="text-ink-2">
            Videos are shared as MP4 files (see Download). For a link students can open in a browser, ask the assistant to <b className="font-medium">make a web animation version</b>.
          </p>
        ) : (
          <div>
            <div className="mb-3 grid grid-cols-3 gap-2">
              {VIS.map((v) => (
                <button
                  key={v.id}
                  onClick={() => {
                    setVisibility(v.id);
                    if (m.publish) void run("vis", async () => {
                      await studio.publish.setVisibility(m.id, v.id);
                      props.onChanged();
                    });
                  }}
                  className="rounded-[11px] p-2.5 text-left"
                  style={{ background: visibility === v.id ? "#fff" : "var(--color-surface-2)", boxShadow: visibility === v.id ? "inset 0 0 0 2px var(--color-ink)" : "inset 0 0 0 1px var(--color-line)" }}
                >
                  {v.icon}
                  <b className="mt-1.5 block text-[12.5px] font-semibold">{v.label}</b>
                  <small className="text-[11px] text-muted">{v.hint}</small>
                </button>
              ))}
            </div>
            {m.publish ? (
              <>
                <div className="flex items-center gap-2 rounded-[10px] bg-surface-2 py-1.5 pl-3 pr-1.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
                  <span className="flex-1 truncate font-mono text-[12px] text-ink-2">{m.publish.url}</span>
                  <button className="btn btn-sm btn-dark" onClick={() => void navigator.clipboard.writeText(m.publish!.url).then(() => setNote("Link copied."))}>
                    Copy
                  </button>
                </div>
                <div className="mt-3 flex gap-2">
                  <button className="btn btn-sm" disabled={!!busy} onClick={publish}>
                    {busy === "publish" ? "Updating…" : "Update with latest changes"}
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => void studio.app.openExternal(m.publish!.url)}>
                    Open
                  </button>
                  <span className="flex-1" />
                  <button
                    className="btn btn-sm btn-ghost text-bad"
                    disabled={!!busy}
                    onClick={() => run("unpublish", async () => {
                      await studio.publish.unpublish(m.id);
                      props.onChanged();
                    })}
                  >
                    Unpublish
                  </button>
                </div>
              </>
            ) : (
              <button className="btn btn-dark w-full justify-center" disabled={!!busy} onClick={publish}>
                {busy === "publish" ? <span className="spinner" /> : null}
                {busy === "publish" ? (account ? "Publishing…" : "Waiting for Google sign-in…") : account ? "Publish" : "Sign in with Google to publish"}
              </button>
            )}
            <p className="mt-2.5 text-[12px] text-muted">
              Free hosting. Students don't need an account.
              {account && (
                <>
                  {" "}Signed in as {account.email} ·{" "}
                  <button className="underline" onClick={() => void studio.publish.signOut().then(() => setAccount(null))}>
                    sign out
                  </button>
                </>
              )}
            </p>
          </div>
        ))}

      {tab === "embed" &&
        (isVideo ? (
          <p className="text-ink-2">Upload the exported MP4 to your LMS or YouTube and embed it from there.</p>
        ) : (
          <div>
            <div className="seg mb-2.5">
              <button data-on={embedMode === "iframe"} onClick={() => setEmbedMode("iframe")}>
                Hosted iframe
              </button>
              <button data-on={embedMode === "full"} onClick={() => setEmbedMode("full")}>
                Full HTML
              </button>
            </div>
            {embedMode === "iframe" ? (
              m.publish ? (
                <>
                  <pre className="max-h-28 overflow-hidden whitespace-pre-wrap break-all rounded-[10px] bg-surface-2 p-3 font-mono text-[11.5px] text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)]">{iframe}</pre>
                  <button className="btn btn-sm btn-dark mt-2.5" onClick={() => void navigator.clipboard.writeText(iframe).then(() => setNote("Embed code copied."))}>
                    Copy embed code
                  </button>
                  <p className="mt-2.5 text-[12px] text-muted">Paste into Google Sites, Canvas, Moodle, Notion or any page that accepts embeds. It updates when you update the link.</p>
                </>
              ) : (
                <p className="text-ink-2">Publish a link first (Link tab), then copy an embed code here.</p>
              )
            ) : (
              <>
                <p className="mt-0 text-ink-2">The whole {m.kind === "lab" ? "Lab" : "animation"} as one piece of HTML, with every library inlined. No account or hosting needed.</p>
                <button
                  className="btn btn-sm btn-dark"
                  disabled={!!busy}
                  onClick={() => run("copy", async () => {
                    const r = await studio.build.copyHtml(m.id);
                    setNote(`Copied ${formatBytes(r.sizeBytes)} of HTML.`);
                  })}
                >
                  {busy === "copy" ? "Building…" : "Copy full HTML"}
                </button>
                <p className="mt-2.5 text-[12px] text-muted">
                  <b className="font-medium text-ink-2">For sites that accept raw HTML</b> (Google Sites "Embed code", WordPress Custom HTML, Squarespace). Many LMS editors remove scripts, so use the iframe or upload the .html file there.
                </p>
              </>
            )}
          </div>
        ))}

      {tab === "download" && (
        <div className="grid gap-2">
          {isVideo ? (
            <Row icon="MP4" title="Video" hint="1080p, every scene rendered in high quality and joined" action={busy === "mp4" ? "Rendering…" : "Export"} disabled={!!busy} onClick={() => run("mp4", async () => {
              const r = await studio.video.exportMp4(m.id);
              if (r) setNote(`Saved to ${r.path}`);
            })} />
          ) : (
            <Row icon="HTML" title="Single HTML file" hint="Everything inlined. Opens offline; upload it to any LMS." action="Download" disabled={!!busy} onClick={() => run("html", async () => {
              const r = await studio.build.exportHtml(m.id);
              if (r) setNote(`Saved to ${r.path}`);
            })} />
          )}
          <Row icon="DIR" title="Project folder" hint="The source files, for editing by hand or backing up" action="Show" onClick={() => void studio.projects.open(m.id).then((p) => studio.app.showInFolder(`${p.dir}/project.json`))} />
        </div>
      )}

      {note && <div className="mt-3 rounded-lg bg-good-soft px-3 py-2 text-[12.5px] text-good">{note}</div>}
      {error && <div className="mt-3 whitespace-pre-wrap rounded-lg bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</div>}

      <div className="mt-5 flex border-t border-line-2 pt-3">
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

function Row(props: { icon: string; title: string; hint: string; action: string; disabled?: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <span className="grid h-9 w-9 flex-none place-items-center rounded-[9px] bg-surface-2 font-mono text-[10px] font-semibold text-ink-2">{props.icon}</span>
      <div className="flex-1">
        <b className="block font-medium">{props.title}</b>
        <small className="text-[12px] text-muted">{props.hint}</small>
      </div>
      <button className="btn btn-sm" disabled={props.disabled} onClick={props.onClick}>
        {props.action === "Download" && <Download size={13} />}
        {props.action}
      </button>
    </div>
  );
}
