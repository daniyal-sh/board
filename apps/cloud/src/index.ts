import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth, loadUser, requireUser } from "./auth";
import { shortId, sign, verify } from "./crypto";
import type { AppContext, Env, Item, Visibility } from "./env";
import { embedPage, galleryPage, homePage, notFoundPage, sharePage } from "./pages";

const VISIBILITIES: Visibility[] = ["private", "unlisted", "public"];

/**
 * Published HTML runs teacher- and AI-written JavaScript. It is served:
 *  - from SANDBOX_ORIGIN, a separate registrable domain, so it can't touch this site's cookies;
 *  - with a CSP "sandbox" directive, so even opened directly it runs in an opaque origin;
 *  - with no network access (connect-src 'none'), so it can't phone home or exfiltrate.
 */
const CONTENT_CSP = [
  "sandbox allow-scripts allow-pointer-lock allow-popups allow-modals",
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "worker-src blob:",
  "frame-ancestors *",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const app = new Hono<AppContext>();

/** Requests to the sandbox host only ever get content. */
app.use("*", async (c, next) => {
  const host = new URL(c.req.url).host;
  if (host === new URL(c.env.SANDBOX_ORIGIN).host && host !== new URL(c.env.APP_ORIGIN).host) {
    const m = /^\/c\/([A-Za-z0-9]{6,16})\/?$/.exec(new URL(c.req.url).pathname);
    if (!m || c.req.method !== "GET") return c.text("Not found", 404);
    return serveContent(c.env, m[1], new URL(c.req.url).searchParams);
  }
  await next();
});

app.use("*", loadUser);
app.route("/auth", auth);

// ---------------------------------------------------------------- API (desktop app)

app.use("/api/*", cors({ origin: (o) => o, allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }));

app.get("/api/me", requireUser, (c) => {
  const u = c.get("user")!;
  return c.json({ email: u.email, name: u.name, picture: u.picture });
});

app.get("/api/items", requireUser, async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT * FROM items WHERE owner_id = ? ORDER BY updated_at DESC`).bind(c.get("user")!.id).all<Item>();
  return c.json(results.map((i) => itemJson(c.env, i)));
});

interface UploadBody {
  title?: string;
  kind?: string;
  visibility?: string;
  html?: string;
}

function validate(env: Env, body: UploadBody, requireHtml: boolean): string | null {
  if (requireHtml && typeof body.html !== "string") return "html is required";
  if (body.html !== undefined && (typeof body.html !== "string" || body.html.length < 20)) return "html is invalid";
  if (body.html && new TextEncoder().encode(body.html).length > Number(env.MAX_UPLOAD_MB) * 1024 * 1024) return `The file is larger than ${env.MAX_UPLOAD_MB} MB`;
  if (body.kind !== undefined && body.kind !== "lab" && body.kind !== "web") return "kind must be lab or web";
  if (body.visibility !== undefined && !VISIBILITIES.includes(body.visibility as Visibility)) return "invalid visibility";
  if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200)) return "invalid title";
  return null;
}

app.post("/api/items", requireUser, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as UploadBody;
  const problem = validate(c.env, body, true) ?? (body.kind ? null : "kind is required");
  if (problem) return c.json({ error: problem }, 400);
  const id = shortId();
  const size = new TextEncoder().encode(body.html!).length;
  await c.env.FILES.put(`items/${id}/1.html`, body.html!, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await c.env.DB.prepare(`INSERT INTO items (id, owner_id, title, kind, visibility, size_bytes) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, c.get("user")!.id, body.title?.trim() || "Untitled", body.kind, body.visibility ?? "unlisted", size)
    .run();
  const item = await getItem(c.env, id);
  return c.json(itemJson(c.env, item!), 201);
});

/** Replace the content (new version) and optionally title/visibility. */
app.put("/api/items/:id", requireUser, async (c) => {
  const item = await ownedItem(c.env, c.req.param("id"), c.get("user")!.id);
  if (!item) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as UploadBody;
  const problem = validate(c.env, body, true);
  if (problem) return c.json({ error: problem }, 400);
  const version = item.version + 1;
  await c.env.FILES.put(`items/${item.id}/${version}.html`, body.html!, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await c.env.DB.prepare(
    `UPDATE items SET version = ?, size_bytes = ?, title = COALESCE(?, title), visibility = COALESCE(?, visibility), updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(version, new TextEncoder().encode(body.html!).length, body.title?.trim() ?? null, body.visibility ?? null, item.id)
    .run();
  await c.env.FILES.delete(`items/${item.id}/${item.version}.html`);
  return c.json(itemJson(c.env, (await getItem(c.env, item.id))!));
});

app.patch("/api/items/:id", requireUser, async (c) => {
  const item = await ownedItem(c.env, c.req.param("id"), c.get("user")!.id);
  if (!item) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as UploadBody;
  const problem = validate(c.env, { title: body.title, visibility: body.visibility }, false);
  if (problem) return c.json({ error: problem }, 400);
  await c.env.DB.prepare(`UPDATE items SET title = COALESCE(?, title), visibility = COALESCE(?, visibility), updated_at = datetime('now') WHERE id = ?`)
    .bind(body.title?.trim() ?? null, body.visibility ?? null, item.id)
    .run();
  return c.json(itemJson(c.env, (await getItem(c.env, item.id))!));
});

app.delete("/api/items/:id", requireUser, async (c) => {
  const item = await ownedItem(c.env, c.req.param("id"), c.get("user")!.id);
  if (!item) return c.json({ error: "Not found" }, 404);
  await c.env.FILES.delete(`items/${item.id}/${item.version}.html`);
  await c.env.DB.prepare(`DELETE FROM items WHERE id = ?`).bind(item.id).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Pages

app.get("/", (c) => c.html(homePage(c.env.APP_NAME)));

app.get("/gallery", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT i.*, COALESCE(u.name, 'A teacher') AS author FROM items i JOIN users u ON u.id = i.owner_id
     WHERE i.visibility = 'public' ORDER BY i.updated_at DESC LIMIT 60`,
  ).all<Item & { author: string }>();
  return c.html(galleryPage(c.env.APP_NAME, results));
});

/** Share page: title, author, the content in a sandboxed iframe. */
app.get("/l/:id", async (c) => {
  const item = await getItem(c.env, c.req.param("id"));
  const user = c.get("user");
  if (!item || (item.visibility === "private" && user?.id !== item.owner_id)) {
    c.status(404);
    return c.html(notFoundPage(c.env.APP_NAME, user ? undefined : `/auth/web?next=/l/${encodeURIComponent(c.req.param("id"))}`));
  }
  c.executionCtx.waitUntil(c.env.DB.prepare(`UPDATE items SET views = views + 1 WHERE id = ?`).bind(item.id).run());
  const author = await c.env.DB.prepare(`SELECT COALESCE(name, 'A teacher') AS n FROM users WHERE id = ?`).bind(item.owner_id).first<{ n: string }>();
  c.header("x-frame-options", "SAMEORIGIN");
  return c.html(sharePage(c.env.APP_NAME, item, author?.n ?? "A teacher", await contentUrl(c.env, item), `${c.env.APP_ORIGIN}/e/${item.id}`));
});

/** Embed page for other sites' iframes. Private items are never embeddable. */
app.get("/e/:id", async (c) => {
  const item = await getItem(c.env, c.req.param("id"));
  if (!item || item.visibility === "private") return c.html(notFoundPage(c.env.APP_NAME), 404);
  return c.html(embedPage(item, await contentUrl(c.env, item)));
});

/** Content on the app host (dev, or when no separate sandbox domain is configured). */
app.get("/c/:id", (c) => serveContent(c.env, c.req.param("id"), new URL(c.req.url).searchParams));

app.notFound((c) => c.html(notFoundPage(c.env.APP_NAME), 404));

// ---------------------------------------------------------------- helpers

async function getItem(env: Env, id: string): Promise<Item | null> {
  if (!/^[A-Za-z0-9]{6,16}$/.test(id)) return null;
  return env.DB.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first<Item>();
}

async function ownedItem(env: Env, id: string, userId: string): Promise<Item | null> {
  const item = await getItem(env, id);
  return item && item.owner_id === userId ? item : null;
}

function itemJson(env: Env, i: Item) {
  return { id: i.id, url: `${env.APP_ORIGIN}/l/${i.id}`, title: i.title, kind: i.kind, visibility: i.visibility, views: i.views, publishedAt: i.updated_at };
}

/** Content URL; private items get a short-lived signed token so only the owner's share page can load them. */
async function contentUrl(env: Env, item: Item): Promise<string> {
  const base = `${env.SANDBOX_ORIGIN}/c/${item.id}?v=${item.version}`;
  if (item.visibility !== "private") return base;
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${base}&exp=${exp}&sig=${await sign(env.SESSION_SECRET, `${item.id}.${exp}`)}`;
}

async function serveContent(env: Env, id: string, params: URLSearchParams): Promise<Response> {
  const item = await getItem(env, id);
  if (!item) return new Response("Not found", { status: 404 });
  if (item.visibility === "private") {
    const exp = Number(params.get("exp"));
    const sig = params.get("sig") ?? "";
    if (!exp || exp < Date.now() / 1000 || !(await verify(env.SESSION_SECRET, `${item.id}.${exp}`, sig))) {
      return new Response("Not found", { status: 404 });
    }
  }
  const obj = await env.FILES.get(`items/${item.id}/${item.version}.html`);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CONTENT_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": item.visibility === "private" ? "private, no-store" : "public, max-age=60",
    },
  });
}

export default app;
