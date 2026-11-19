const enc = new TextEncoder();

export function randomToken(bytes = 32): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(a);
}

/** Short, URL-friendly ids for share links (base62, ~59 bits). */
export function shortId(length = 10): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += alphabet[b % 62];
  return out;
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return base64url(new Uint8Array(d));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
  return base64url(new Uint8Array(sig));
}

export async function verify(secret: string, data: string, signature: string): Promise<boolean> {
  return timingSafeEqual(await sign(secret, data), signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** value.signature, for small signed cookies. */
export async function seal(secret: string, value: object): Promise<string> {
  const body = base64url(enc.encode(JSON.stringify(value)));
  return `${body}.${await sign(secret, body)}`;
}

export async function unseal<T>(secret: string, sealed: string | undefined): Promise<T | null> {
  if (!sealed) return null;
  const [body, sig] = sealed.split(".");
  if (!body || !sig || !(await verify(secret, body, sig))) return null;
  try {
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as T;
  } catch {
    return null;
  }
}
