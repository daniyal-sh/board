import type { Item } from "./env";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const STYLE = `
:root{--bg:#F3F1EC;--surface:#fff;--ink:#17171C;--ink2:#43434D;--muted:#85838E;--line:#E7E4DD;--accent:#5146E5;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#121216;--surface:#1b1b21;--ink:#f1f0ec;--ink2:#c9c7cf;--muted:#8e8c97;--line:#2c2c34;--accent:#8b84ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 var(--sans)}
a{color:inherit}.wrap{max-width:1080px;margin:0 auto;padding:20px}
header.top{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid var(--line)}
header.top a.brand{font-family:var(--serif);font-size:20px;text-decoration:none}
.frame{position:relative;width:100%;background:var(--surface);border-radius:14px;overflow:hidden;box-shadow:0 16px 40px -16px rgba(0,0,0,.3),0 0 0 1px rgba(0,0,0,.06)}
.frame iframe{display:block;width:100%;border:0}
h1{font-family:var(--serif);font-weight:500;font-size:clamp(26px,4vw,36px);margin:18px 0 4px;letter-spacing:-.01em}
.meta{color:var(--muted);font-size:14px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:9px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font:500 14px var(--sans);text-decoration:none;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-top:18px}
.card{display:block;padding:16px;border-radius:14px;background:var(--surface);box-shadow:0 0 0 1px var(--line);text-decoration:none}
.card b{display:block;font-weight:600}.card span{color:var(--muted);font-size:13px}
.empty{color:var(--muted);padding:40px 0}
footer{color:var(--muted);font-size:13px;padding:30px 20px;text-align:center}
`;

function layout(appName: string, title: string, body: string, opts: { description?: string; image?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${opts.description ? `<meta name="description" content="${esc(opts.description)}"><meta property="og:description" content="${esc(opts.description)}">` : ""}
<meta property="og:title" content="${esc(title)}"><meta name="referrer" content="strict-origin-when-cross-origin">
<style>${STYLE}</style></head><body>
<header class="top"><a class="brand" href="/">${esc(appName)}</a><span style="flex:1"></span><a class="btn" href="/gallery">Gallery</a></header>
${body}
<footer>Made with ${esc(appName)}, an open-source studio for teachers.</footer>
</body></html>`;
}

export function sharePage(appName: string, item: Item, author: string, contentUrl: string, embedUrl: string): string {
  const aspect = item.kind === "web" ? "aspect-ratio:16/9" : "height:min(82vh,900px)";
  return layout(
    appName,
    item.title,
    `<div class="wrap">
  <div class="frame" style="${aspect}"><iframe src="${esc(contentUrl)}" title="${esc(item.title)}" style="height:100%"
    sandbox="allow-scripts allow-pointer-lock allow-popups" allow="fullscreen" referrerpolicy="no-referrer" loading="eager"></iframe></div>
  <h1>${esc(item.title)}</h1>
  <div class="meta">by ${esc(author)} · ${item.kind === "lab" ? "Lab" : "Web animation"} · updated ${esc(item.updated_at.slice(0, 10))}</div>
  <p style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">
    <button class="btn" onclick="navigator.clipboard.writeText(location.href);this.textContent='Link copied'">Copy link</button>
    <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('embed').value);this.textContent='Embed code copied'">Copy embed code</button>
    <a class="btn" href="${esc(contentUrl)}" target="_blank" rel="noopener">Open full screen</a>
  </p>
  <input id="embed" type="hidden" value="${esc(`<iframe src="${embedUrl}" width="100%" height="560" style="border:0;border-radius:12px" allow="fullscreen" loading="lazy"></iframe>`)}">
</div>`,
    { description: `${item.kind === "lab" ? "An interactive Lab" : "An animated explanation"} by ${author}.` },
  );
}

/** Minimal page for iframes on other sites (LMS, Google Sites): just the content, full size. */
export function embedPage(item: Item, contentUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(item.title)}</title><style>html,body{margin:0;height:100%;background:#0E0E12}iframe{display:block;width:100%;height:100%;border:0}</style></head>
<body><iframe src="${esc(contentUrl)}" title="${esc(item.title)}" sandbox="allow-scripts allow-pointer-lock allow-popups" allow="fullscreen" referrerpolicy="no-referrer"></iframe></body></html>`;
}

export function galleryPage(appName: string, items: (Item & { author: string })[]): string {
  return layout(
    appName,
    `${appName} gallery`,
    `<div class="wrap"><h1>Gallery</h1><div class="meta">Labs and animations teachers have shared publicly.</div>
<div class="grid">${
      items.length
        ? items
            .map((i) => `<a class="card" href="/l/${esc(i.id)}"><b>${esc(i.title)}</b><span>${i.kind === "lab" ? "Lab" : "Web animation"} · ${esc(i.author)}</span></a>`)
            .join("")
        : `<div class="empty">Nothing public yet.</div>`
    }</div></div>`,
  );
}

export function homePage(appName: string): string {
  return layout(
    appName,
    appName,
    `<div class="wrap" style="padding-top:60px;max-width:760px">
<h1 style="font-size:48px">Make maths and science visible.</h1>
<p style="color:var(--ink2);font-size:18px">${esc(appName)} is a free, open-source desktop app for teachers. Describe an idea and an AI assistant you already use (Claude Code or Codex) builds a Manim video, a web animation, or an interactive Lab. Share it here with a link.</p>
<p><a class="btn" href="/gallery">Browse the gallery</a></p></div>`,
  );
}

export function notFoundPage(appName: string, signInHref?: string): string {
  return layout(
    appName,
    "Not found",
    `<div class="wrap empty"><h1>This link isn't available</h1><p>It may be private, or it was removed.</p>${
      signInHref ? `<p><a class="btn" href="${esc(signInHref)}">Sign in with Google</a> if you own it.</p>` : ""
    }</div>`,
  );
}
