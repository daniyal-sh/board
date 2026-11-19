import fs from "node:fs";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { safeStorage, shell } from "electron";
import type { Account, PublishInfo, PublishRequest, Visibility } from "@studio/shared";
import { buildExport } from "./build/preview";
import { paths } from "./paths";
import { projects } from "./projects";

/** Base URL of the cloud API. Override with STUDIO_CLOUD_URL (e.g. http://127.0.0.1:8787 for `wrangler dev`). */
export const CLOUD_URL = (process.env.STUDIO_CLOUD_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

const tokenFile = () => join(paths.dataDir, "cloud-token.bin");

function readToken(): string | null {
  try {
    const raw = fs.readFileSync(tokenFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8");
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  if (!token) {
    fs.rmSync(tokenFile(), { force: true });
    return;
  }
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, "utf8");
  fs.writeFileSync(tokenFile(), data);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readToken();
  if (!token) throw new Error("Sign in with Google to publish.");
  const res = await fetch(`${CLOUD_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    writeToken(null);
    throw new Error("Your sign-in expired. Sign in again to publish.");
  }
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `Request failed (${res.status})`);
  return (await res.json()) as T;
}

export async function account(): Promise<Account | null> {
  if (!readToken()) return null;
  try {
    return await api<Account>("/api/me");
  } catch {
    return null;
  }
}

/**
 * Google sign-in for a desktop app: open the browser at the cloud's start URL with a loopback
 * port; the cloud completes OAuth and redirects back to http://127.0.0.1:<port>/callback?token=…
 */
export function signIn(): Promise<Account> {
  return new Promise((resolve, reject) => {
    const state = randomBytes(16).toString("hex");
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.get("state") === state && url.searchParams.get("token");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        `<!doctype html><meta charset="utf-8"><title>Signed in</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;color:#17171C;background:#F3F1EC">` +
          (ok ? "<p>You're signed in. You can close this tab and go back to the app.</p>" : "<p>Sign-in failed. Please try again from the app.</p>"),
      );
      server.close();
      clearTimeout(timer);
      if (!ok) return reject(new Error("Sign-in was cancelled or failed."));
      writeToken(url.searchParams.get("token"));
      const me = await account();
      if (me) resolve(me);
      else reject(new Error("Signed in, but the account could not be loaded."));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Sign-in timed out."));
    }, 5 * 60 * 1000);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      void shell.openExternal(`${CLOUD_URL}/auth/desktop?port=${port}&state=${state}`);
    });
  });
}

/** Store a session token directly (self-tests only; real sign-in goes through signIn()). */
export function setTokenForTesting(token: string): void {
  writeToken(token);
}

export function signOut(): void {
  writeToken(null);
}

interface ItemResponse {
  id: string;
  url: string;
  visibility: Visibility;
  publishedAt: string;
}

export async function publish(req: PublishRequest): Promise<PublishInfo> {
  const m = projects.manifest(req.projectId);
  if (m.kind === "video") throw new Error("Videos are shared as MP4 files for now. Convert to a web animation to get a link.");
  const built = await buildExport(req.projectId);
  const body = JSON.stringify({ title: m.title, kind: m.kind, visibility: req.visibility, html: built.html });
  const res = m.publish?.id
    ? await api<ItemResponse>(`/api/items/${m.publish.id}`, { method: "PUT", body, headers: { "content-type": "application/json" } })
    : await api<ItemResponse>("/api/items", { method: "POST", body, headers: { "content-type": "application/json" } });
  const info: PublishInfo = { id: res.id, url: res.url, visibility: res.visibility, publishedAt: res.publishedAt };
  projects.saveManifest({ ...m, publish: info });
  return info;
}

export async function setVisibility(projectId: string, visibility: Visibility): Promise<PublishInfo> {
  const m = projects.manifest(projectId);
  if (!m.publish) throw new Error("Not published yet.");
  const res = await api<ItemResponse>(`/api/items/${m.publish.id}`, {
    method: "PATCH",
    body: JSON.stringify({ visibility }),
    headers: { "content-type": "application/json" },
  });
  const info: PublishInfo = { ...m.publish, visibility: res.visibility };
  projects.saveManifest({ ...m, publish: info });
  return info;
}

export async function unpublish(projectId: string): Promise<void> {
  const m = projects.manifest(projectId);
  if (!m.publish) return;
  await api(`/api/items/${m.publish.id}`, { method: "DELETE" });
  projects.saveManifest({ ...m, publish: undefined });
}
