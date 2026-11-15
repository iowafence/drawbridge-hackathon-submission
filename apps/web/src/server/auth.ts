// Operator authentication for the sandbox integration. Server-side only.
// One human operator, identified by a passphrase whose scrypt hash (never the passphrase) is in the server environment.
// Sessions are random tokens held in server memory; the browser gets an HttpOnly, SameSite=Strict cookie.
// If no hash is configured, everything is refused (fail closed).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const COOKIE = "db_operator";
const SESSION_MS = 30 * 60_000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

type Session = { exp: number; csrf: string; name: string };
type Store = { sessions: Map<string, Session>; failures: number; lockedUntil: number };
const g = globalThis as unknown as { __drawbridgeAuth?: Store };
const store = (): Store => (g.__drawbridgeAuth ??= { sessions: new Map(), failures: 0, lockedUntil: 0 });
const h = (s: string) => createHash("sha256").update(s).digest("hex");

export function hashPassphrase(passphrase: string, salt: Buffer = randomBytes(16)): string {
  return `scrypt:16384:8:1:${salt.toString("base64")}:${scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 }).toString("base64")}`;
}

export function authConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return /^scrypt:16384:8:1:[A-Za-z0-9+/=]{20,}:[A-Za-z0-9+/=]{40,}$/.test(env.DRAWBRIDGE_OPERATOR_SCRYPT ?? "");
}

/** Constant-time passphrase check with a global lockout after repeated failures. */
export function verifyPassphrase(passphrase: unknown, env: Record<string, string | undefined> = process.env, now = Date.now()): "OK" | "REFUSED" | "LOCKED" | "NOT_CONFIGURED" {
  if (!authConfigured(env)) return "NOT_CONFIGURED";
  const s = store();
  if (now < s.lockedUntil) return "LOCKED";
  const [, , , , saltB64, hashB64] = env.DRAWBRIDGE_OPERATOR_SCRYPT!.split(":");
  const expected = Buffer.from(hashB64, "base64");
  const got = scryptSync(typeof passphrase === "string" ? passphrase : "", Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  if (typeof passphrase === "string" && passphrase.length >= 12 && timingSafeEqual(got, expected)) {
    s.failures = 0;
    return "OK";
  }
  if (++s.failures >= MAX_FAILURES) {
    s.failures = 0;
    s.lockedUntil = now + LOCKOUT_MS;
  }
  return "REFUSED";
}

export function createSession(name: string, now = Date.now()): { token: string; csrf: string } {
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  store().sessions.set(h(token), { exp: now + SESSION_MS, csrf, name });
  return { token, csrf };
}

export function getSession(token: string | undefined | null, now = Date.now()): Session | null {
  if (!token) return null;
  const s = store().sessions.get(h(token));
  if (!s) return null;
  if (s.exp <= now) {
    store().sessions.delete(h(token));
    return null;
  }
  return s;
}

export function destroySession(token: string | undefined | null): void {
  if (token) store().sessions.delete(h(token));
}

export function cookieToken(cookieHeader: string | null): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

export function sameCsrf(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** State-changing requests must come from this site: Origin must be present and match Host, and Host must be this
 *  machine's loopback address (the app is a local operator console; this also defeats DNS rebinding). */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  const site = req.headers.get("sec-fetch-site");
  if (!origin || !host || !LOOPBACK.test(host)) return false;
  if (site && site !== "same-origin") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function resetAuthForTests(): void {
  g.__drawbridgeAuth = undefined;
}
