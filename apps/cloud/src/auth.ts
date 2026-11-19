import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { randomToken, seal, sha256, unseal } from "./crypto";
import type { AppContext, Env, User } from "./env";

const SESSION_DAYS = 90;
const STATE_COOKIE = "studio_oauth";
export const SESSION_COOKIE = "studio_session";

interface OAuthState {
  nonce: string;
  /** "desktop": redirect to the app's loopback port. "web": set a cookie and go to `next`. */
  mode: "desktop" | "web";
  port?: number;
  appState?: string;
  next?: string;
  exp: number;
}

/** Attach the signed-in user (Bearer token from the app, or session cookie in the browser). */
export const loadUser: MiddlewareHandler<AppContext> = async (c, next) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : getCookie(c, SESSION_COOKIE);
  c.set("user", token ? await userForToken(c.env, token) : null);
  await next();
};

export const requireUser: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Sign in required" }, 401);
  await next();
};

async function userForToken(env: Env, token: string): Promise<User | null> {
  const hash = await sha256(token);
  return env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
  )
    .bind(hash)
    .first<User>();
}

async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .bind(await sha256(token), userId, `+${SESSION_DAYS} days`)
    .run();
  return token;
}

function googleAuthUrl(env: Env, nonce: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", `${env.APP_ORIGIN}/auth/google/callback`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", nonce);
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

export const auth = new Hono<AppContext>();

/** Desktop app sign-in: /auth/desktop?port=<loopback port>&state=<app state> */
auth.get("/desktop", async (c) => {
  const port = Number(c.req.query("port"));
  const appState = c.req.query("state") ?? "";
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[0-9a-f]{16,64}$/.test(appState)) {
    return c.text("Invalid sign-in request", 400);
  }
  return startGoogle(c, { mode: "desktop", port, appState });
});

/** Browser sign-in (to view your own private items): /auth/web?next=/l/<id> */
auth.get("/web", async (c) => {
  const next = c.req.query("next") ?? "/";
  return startGoogle(c, { mode: "web", next: next.startsWith("/") && !next.startsWith("//") ? next : "/" });
});

async function startGoogle(c: Context<AppContext>, s: Omit<OAuthState, "nonce" | "exp">) {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.text("Google sign-in is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).", 503);
  }
  const nonce = randomToken(16);
  const state: OAuthState = { ...s, nonce, exp: Date.now() + 10 * 60 * 1000 };
  setCookie(c, STATE_COOKIE, await seal(c.env.SESSION_SECRET, state), {
    httpOnly: true,
    secure: c.env.APP_ORIGIN.startsWith("https:"),
    sameSite: "Lax",
    path: "/auth",
    maxAge: 600,
  });
  return c.redirect(googleAuthUrl(c.env, nonce));
}

auth.get("/google/callback", async (c) => {
  const state = await unseal<OAuthState>(c.env.SESSION_SECRET, getCookie(c, STATE_COOKIE));
  deleteCookie(c, STATE_COOKIE, { path: "/auth" });
  const code = c.req.query("code");
  if (!state || state.exp < Date.now() || state.nonce !== c.req.query("state") || !code) {
    return c.text("Sign-in expired or was cancelled. Please try again.", 400);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${c.env.APP_ORIGIN}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return c.text("Google sign-in failed.", 502);
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${access_token}` } });
  if (!infoRes.ok) return c.text("Could not read your Google profile.", 502);
  const info = (await infoRes.json()) as { sub: string; email: string; email_verified?: boolean; name?: string; picture?: string };
  if (!info.email_verified) return c.text("Your Google email address is not verified.", 403);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, name, picture) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture`,
  )
    .bind(id, info.sub, info.email, info.name ?? null, info.picture ?? null)
    .run();
  const user = await c.env.DB.prepare(`SELECT id FROM users WHERE google_sub = ?`).bind(info.sub).first<{ id: string }>();
  const token = await createSession(c.env, user!.id);

  if (state.mode === "desktop") {
    const back = new URL(`http://127.0.0.1:${state.port}/callback`);
    back.searchParams.set("token", token);
    back.searchParams.set("state", state.appState ?? "");
    return c.redirect(back.toString());
  }
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.env.APP_ORIGIN.startsWith("https:"),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return c.redirect(state.next ?? "/");
});

auth.post("/logout", async (c) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
