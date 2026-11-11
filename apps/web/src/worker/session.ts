/**
 * Short-lived session cookie, issued after a Turnstile check and signed with
 * HMAC-SHA256. Holds only an expiry time; no user data.
 */

export const SESSION_COOKIE = "mofu_session";
const MIN_SECRET_LENGTH = 32;

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): string {
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  return atob(padded);
}

async function sign(secret: string, data: string): Promise<string> {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

/** Compares in time independent of where the strings differ. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(
  secret: string,
  now: number,
  ttlMs: number,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = now + ttlMs;
  const payload = base64url(encoder.encode(JSON.stringify({ exp: expiresAt })));
  return { token: `${payload}.${await sign(secret, payload)}`, expiresAt };
}

export async function verifySessionToken(
  secret: string,
  token: string | undefined,
  now: number,
): Promise<boolean> {
  if (!token) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return false;
  if (!constantTimeEqual(signature, await sign(secret, payload))) return false;
  try {
    const { exp } = JSON.parse(fromBase64url(payload)) as { exp?: unknown };
    return typeof exp === "number" && exp > now;
  } catch {
    return false;
  }
}

/**
 * General signed token for other short-lived data (a wallet challenge, a holder cookie).
 * `purpose` is part of what's signed, so a token made for one use can't stand in for another.
 */
export async function createSignedToken(
  secret: string,
  purpose: string,
  data: Record<string, unknown>,
  now: number,
  ttlMs: number,
): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify({ ...data, exp: now + ttlMs })));
  return `${payload}.${await sign(secret, `${purpose}:${payload}`)}`;
}

/** Returns the token's data if the signature, purpose and expiry check out, else null. */
export async function readSignedToken(
  secret: string,
  purpose: string,
  token: string | undefined,
  now: number,
): Promise<Record<string, unknown> | null> {
  if (!token || token.length > 2048) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  if (!constantTimeEqual(signature, await sign(secret, `${purpose}:${payload}`))) return null;
  try {
    const data = JSON.parse(fromBase64url(payload)) as Record<string, unknown>;
    return typeof data.exp === "number" && data.exp > now ? data : null;
  } catch {
    return null;
  }
}
