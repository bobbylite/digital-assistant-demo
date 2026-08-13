import { createHash } from "crypto";
import { cookies } from "next/headers";
import { EncryptJWT, jwtDecrypt, type JWTPayload } from "jose";

/**
 * Server-only. The browser only ever receives the sealed (encrypted +
 * authenticated) JWE compact string as a cookie value — it cannot read or
 * tamper with the payload, and the raw AgentCore access token embedded in
 * it never appears in any response body the browser can inspect.
 */

const SESSION_COOKIE = "agentcore_session";
const PENDING_COOKIE = "agentcore_oidc_pending";

const PENDING_MAX_AGE = 10 * 60; // minutes to complete the IdP redirect round trip
const SESSION_MAX_AGE = 8 * 60 * 60; // hard cap regardless of the access token's own exp

function sessionKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("Missing required env var: SESSION_SECRET. See .env.local.example.");
  }
  // SHA-256 normalizes any-length secret into the 32 bytes A256GCM needs.
  // This does not add entropy — SESSION_SECRET itself must be a long random
  // value (e.g. `openssl rand -base64 32`), hashing just fixes the length.
  return createHash("sha256").update(secret).digest();
}

async function seal<T extends object>(payload: T, maxAgeSeconds: number): Promise<string> {
  // Cast is safe: T is constrained to a plain object at every call site
  // below, jose's JWTPayload type just requires a string-keyed index
  // signature TypeScript won't infer generically here.
  return new EncryptJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + maxAgeSeconds)
    .encrypt(sessionKey());
}

async function unseal<T>(token: string): Promise<T | null> {
  try {
    const { payload } = await jwtDecrypt<T & JWTPayload>(token, sessionKey());
    return payload;
  } catch {
    // Wrong key, malformed, tampered, or expired — all treated the same:
    // no valid session. jwtDecrypt enforces `exp` itself.
    return null;
  }
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export interface PendingLogin {
  codeVerifier: string;
  state: string;
  nonce: string;
}

export async function setPendingLogin(data: PendingLogin): Promise<void> {
  const store = await cookies();
  store.set(PENDING_COOKIE, await seal(data, PENDING_MAX_AGE), cookieOptions(PENDING_MAX_AGE));
}

export async function getAndClearPendingLogin(): Promise<PendingLogin | null> {
  const store = await cookies();
  const raw = store.get(PENDING_COOKIE)?.value;
  store.delete(PENDING_COOKIE);
  if (!raw) return null;
  return unseal<PendingLogin>(raw);
}

/** Clears a stale pending-login cookie (e.g. an abandoned login) without needing to decrypt it. */
export async function clearPendingLogin(): Promise<void> {
  const store = await cookies();
  store.delete(PENDING_COOKIE);
}

export interface UserSession {
  accessToken: string;
  // Kept only to pass as id_token_hint to the IdP's end-session endpoint on
  // logout, so RP-Initiated Logout can terminate PingOne's own SSO session
  // too — never sent anywhere else, never used as a bearer token.
  idToken?: string;
  sub: string;
  name?: string;
  email?: string;
}

export async function setUserSession(data: UserSession, expiresInSeconds?: number): Promise<void> {
  const maxAge = Math.min(expiresInSeconds && expiresInSeconds > 0 ? expiresInSeconds : SESSION_MAX_AGE, SESSION_MAX_AGE);
  const store = await cookies();
  store.set(SESSION_COOKIE, await seal(data, maxAge), cookieOptions(maxAge));
}

export async function getUserSession(): Promise<UserSession | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  return unseal<UserSession>(raw);
}

export async function clearUserSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
