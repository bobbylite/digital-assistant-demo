import * as client from "openid-client";

/**
 * Server-only. Never import this from a "use client" component — unlike
 * src/lib/env.ts, nothing here is NEXT_PUBLIC_-prefixed on purpose, since
 * OIDC_CLIENT_SECRET and SESSION_SECRET must never reach the browser bundle.
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

let configPromise: Promise<client.Configuration> | null = null;

/**
 * Discovers the IdP's authorization/token/jwks endpoints from
 * OIDC_DISCOVERY_URL and returns a cached openid-client Configuration.
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

    // openid-client refuses plain HTTP to the IdP by default — a good
    // default we do not want to weaken in production. The `execute` escape
    // hatch below exists only so a local mock/dev IdP served over http://
    // (e.g. in tests) works; it's never reached for a real https:// deployment
    // talking to PingOne, and never applies in production regardless.
    const options: client.DiscoveryRequestOptions | undefined =
      process.env.NODE_ENV !== "production" && discoveryUrl.protocol === "http:"
        ? { execute: [client.allowInsecureRequests] }
        : undefined;

    configPromise = client
      .discovery(discoveryUrl, env.clientId, undefined, client.ClientSecretBasic(env.clientSecret), options)
      .catch((err) => {
        configPromise = null; // don't cache a failed discovery — allow retry on next request
        throw err;
      });
  }
  return configPromise;
}
