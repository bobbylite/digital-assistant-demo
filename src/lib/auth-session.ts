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
const AGENT_TOKEN_COOKIE = "agentcore_agent_token";
const EXCHANGED_TOKEN_COOKIE = "agentcore_exchanged_token";

const PENDING_MAX_AGE = 10 * 60; // minutes to complete the IdP redirect round trip
const SESSION_MAX_AGE = 8 * 60 * 60; // hard cap regardless of the access token's own exp
const AGENT_TOKEN_MAX_AGE = 60 * 60; // client-credentials tokens are typically short-lived; re-auth beats a stale cache
const EXCHANGED_TOKEN_MAX_AGE = 60 * 60; // same reasoning as the agent token above

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

// Separate cookie from UserSession above — this is the *agent's* own
// machine identity (client credentials grant), not a user's. Keeping them
// apart mirrors the RFC 8693 exchange this is a building block for:
// subject_token (user) and actor_token (agent) are two distinct tokens
// combined later, not one replacing the other.
export interface AgentTokenData {
  accessToken: string;
}

export async function setAgentToken(data: AgentTokenData, expiresInSeconds?: number): Promise<void> {
  const maxAge = Math.min(
    expiresInSeconds && expiresInSeconds > 0 ? expiresInSeconds : AGENT_TOKEN_MAX_AGE,
    AGENT_TOKEN_MAX_AGE
  );
  const store = await cookies();
  store.set(AGENT_TOKEN_COOKIE, await seal(data, maxAge), cookieOptions(maxAge));
}

export async function getAgentToken(): Promise<AgentTokenData | null> {
  const store = await cookies();
  const raw = store.get(AGENT_TOKEN_COOKIE)?.value;
  if (!raw) return null;
  return unseal<AgentTokenData>(raw);
}

export async function clearAgentToken(): Promise<void> {
  const store = await cookies();
  store.delete(AGENT_TOKEN_COOKIE);
}

// The result of the RFC 8693 exchange: subject_token (user, from
// UserSession above) + actor_token (agent, from AgentTokenData above)
// combined into one delegated token that carries both identities. This is
// the token that actually gets sent to AgentCore once it exists — see the
// priority order in /api/invoke/route.ts. Separate cookie from both inputs
// rather than overwriting either one, since the raw agent token and user
// session both stay independently meaningful (e.g. re-running the exchange
// doesn't require re-running the user's login).
export interface ExchangedTokenData {
  accessToken: string;
}

export async function setExchangedToken(data: ExchangedTokenData, expiresInSeconds?: number): Promise<void> {
  const maxAge = Math.min(
    expiresInSeconds && expiresInSeconds > 0 ? expiresInSeconds : EXCHANGED_TOKEN_MAX_AGE,
    EXCHANGED_TOKEN_MAX_AGE
  );
  const store = await cookies();
  store.set(EXCHANGED_TOKEN_COOKIE, await seal(data, maxAge), cookieOptions(maxAge));
}

export async function getExchangedToken(): Promise<ExchangedTokenData | null> {
  const store = await cookies();
  const raw = store.get(EXCHANGED_TOKEN_COOKIE)?.value;
  if (!raw) return null;
  return unseal<ExchangedTokenData>(raw);
}

export async function clearExchangedToken(): Promise<void> {
  const store = await cookies();
  store.delete(EXCHANGED_TOKEN_COOKIE);
}
