import * as client from "openid-client";

/**
 * Server-only. Never import this from a "use client" component — nothing
 * here is NEXT_PUBLIC_-prefixed, on purpose, since OIDC_CLIENT_SECRET and
 * SESSION_SECRET must never reach the browser bundle.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}. See .env.local.example.`);
  }
  return value;
}

export function isOidcConfigured(): boolean {
  return Boolean(
    process.env.OIDC_CLIENT_ID &&
      process.env.OIDC_CLIENT_SECRET &&
      process.env.OIDC_DISCOVERY_URL &&
      process.env.OIDC_REDIRECT_URI &&
      process.env.SESSION_SECRET
  );
}

export function getOidcEnv() {
  const redirectUri = required("OIDC_REDIRECT_URI");
  return {
    clientId: required("OIDC_CLIENT_ID"),
    clientSecret: required("OIDC_CLIENT_SECRET"),
    discoveryUrl: required("OIDC_DISCOVERY_URL"),
    redirectUri,
    scopes: process.env.OIDC_SCOPES?.trim() || "openid profile email",
    // Where PingOne sends the browser back to after RP-Initiated Logout.
    // Must be registered as a "Sign Off URL" on the PingOne application, the
    // same way redirectUri must be registered as a redirect URI — PingOne
    // will not follow an unregistered one. Defaults to the app origin.
    postLogoutRedirectUri: process.env.OIDC_POST_LOGOUT_REDIRECT_URI?.trim() || new URL("/", redirectUri).toString(),
  };
}

// openid-client refuses plain HTTP to the IdP by default — a good default
// we do not want to weaken in production. The `execute` escape hatch this
// produces exists only so a local mock/dev IdP served over http:// (e.g. in
// tests) works; it's never reached for a real https:// deployment talking
// to PingOne, and never applies in production regardless.
function insecureDiscoveryOptions(discoveryUrl: URL): client.DiscoveryRequestOptions | undefined {
  return process.env.NODE_ENV !== "production" && discoveryUrl.protocol === "http:"
    ? { execute: [client.allowInsecureRequests] }
    : undefined;
}

let configPromise: Promise<client.Configuration> | null = null;

/**
 * Discovers the IdP's authorization/token/jwks endpoints from
 * OIDC_DISCOVERY_URL and returns a cached openid-client Configuration for
 * the user-login client (OIDC_CLIENT_ID).
 *
 * We pass the full discovery-document URL rather than a bare issuer URL,
 * matching how OIDC_DISCOVERY_URL is documented — openid-client treats this
 * as shorthand for "fetch this URL as the discovery document," which skips
 * its extra issuer == server-argument validation. The tradeoff is
 * deliberate: PingOne's discovery URL is an admin-configured env var, not
 * user input, so the residual risk is low.
 *
 * Client auth is pinned to client_secret_basic (HTTP Basic, RFC 6749 §2.3.1)
 * because that's what this PingOne application requires — its token
 * endpoint returns invalid_client ("Unsupported authentication method") for
 * client_secret_post, openid-client's default when a bare secret string is
 * passed. If you swap in a PingOne app configured for client_secret_post
 * instead, change this back to just passing env.clientSecret as the
 * metadata shorthand (4th arg becomes unnecessary).
 */
export function getOidcConfiguration(): Promise<client.Configuration> {
  if (!configPromise) {
    const env = getOidcEnv();
    const discoveryUrl = new URL(env.discoveryUrl);
    configPromise = client
      .discovery(discoveryUrl, env.clientId, undefined, client.ClientSecretBasic(env.clientSecret), insecureDiscoveryOptions(discoveryUrl))
      .catch((err) => {
        configPromise = null; // don't cache a failed discovery — allow retry on next request
        throw err;
      });
  }
  return configPromise;
}

/**
 * The agent's own machine identity — a separate PingOne application from
 * the user-login one above, authenticating itself via OAuth 2.0 Client
 * Credentials Grant (no user, no browser redirect, no consent screen: the
 * agent proves who *it* is directly to the token endpoint). Deliberately
 * independent of OIDC_CLIENT_ID/OIDC_CLIENT_SECRET — an agent identity
 * shouldn't require user-login to be configured, or vice versa — so this
 * does its own discovery() call against the same OIDC_DISCOVERY_URL rather
 * than reusing getOidcConfiguration()'s cached Configuration.
 *
 * This token becomes the actor_token in an RFC 8693 token exchange
 * immediately after — see /api/auth/agent-token/route.ts — combined with
 * the user's own OIDC token (subject_token) into a single delegated token
 * that carries both identities. That final exchanged token, not this raw
 * one, is what /api/invoke actually sends to AgentCore when present.
 */
export function isAgentConfigured(): boolean {
  return Boolean(process.env.AGENT_CLIENT_ID && process.env.AGENT_CLIENT_SECRET && process.env.OIDC_DISCOVERY_URL && process.env.SESSION_SECRET);
}

export function getAgentEnv() {
  return {
    clientId: required("AGENT_CLIENT_ID"),
    clientSecret: required("AGENT_CLIENT_SECRET"),
    discoveryUrl: required("OIDC_DISCOVERY_URL"),
    scope: process.env.AGENT_SCOPE?.trim() || "agent",
    // Scope requested on the RFC 8693 exchange itself — distinct from the
    // scope above, which is for the client_credentials grant that produces
    // the actor_token in the first place.
    exchangeScope: process.env.AGENT_EXCHANGE_SCOPE?.trim() || "agent:exchange",
  };
}

let agentConfigPromise: Promise<client.Configuration> | null = null;

export function getAgentConfiguration(): Promise<client.Configuration> {
  if (!agentConfigPromise) {
    const env = getAgentEnv();
    const discoveryUrl = new URL(env.discoveryUrl);
    agentConfigPromise = client
      .discovery(discoveryUrl, env.clientId, undefined, client.ClientSecretBasic(env.clientSecret), insecureDiscoveryOptions(discoveryUrl))
      .catch((err) => {
        agentConfigPromise = null;
        throw err;
      });
  }
  return agentConfigPromise;
}

/**
 * Called by src/lib/settings.ts whenever AGENT_CLIENT_ID/AGENT_CLIENT_SECRET
 * change at runtime (via the Settings panel). The cached Configuration above
 * has the *old* client_id/secret baked into it by client.discovery() — just
 * updating process.env isn't enough, the next getAgentConfiguration() call
 * needs to re-discover from scratch to pick up the new credentials.
 */
export function resetAgentConfiguration(): void {
  agentConfigPromise = null;
}
