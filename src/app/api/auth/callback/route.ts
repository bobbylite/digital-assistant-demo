import * as client from "openid-client";
import { getOidcConfiguration, isOidcConfigured } from "@/lib/oidc";
import { getAndClearPendingLogin, setUserSession } from "@/lib/auth-session";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const home = new URL("/", request.url);

  if (!isOidcConfigured()) {
    home.searchParams.set("auth_error", "not_configured");
    return Response.redirect(home.toString(), 302);
  }

  const pending = await getAndClearPendingLogin();
  if (!pending) {
    // Missing/expired/already-used pending cookie — could be a stale tab,
    // a replayed callback, or a CSRF attempt. Fail closed either way.
    home.searchParams.set("auth_error", "expired_login");
    return Response.redirect(home.toString(), 302);
  }

  let config: client.Configuration;
  try {
    config = await getOidcConfiguration();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    home.searchParams.set("auth_error", "discovery_failed");
    home.searchParams.set("auth_error_detail", detail);
    console.error("OIDC discovery failed:", detail);
    return Response.redirect(home.toString(), 302);
  }

  try {
    // Validates `state`, exchanges the code at the token endpoint (with our
    // PKCE code_verifier), and verifies the ID token's signature (via JWKS
    // from discovery), issuer, audience, expiry, and `nonce` — all inside
    // this one call. This is the whole reason to use openid-client instead
    // of hand-rolling the token exchange: none of those checks are optional
    // for security, and they're easy to get subtly wrong by hand.
    const tokens = await client.authorizationCodeGrant(config, new URL(request.url), {
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      pkceCodeVerifier: pending.codeVerifier,
    });

    const claims = tokens.claims();
    const sub = claims?.sub;
    if (!sub || !tokens.access_token) {
      home.searchParams.set("auth_error", "incomplete_response");
      return Response.redirect(home.toString(), 302);
    }

    await setUserSession(
      {
        accessToken: tokens.access_token,
        idToken: tokens.id_token,
        sub,
        name: typeof claims?.name === "string" ? claims.name : undefined,
        email: typeof claims?.email === "string" ? claims.email : undefined,
      },
      tokens.expiresIn()
    );

    return Response.redirect(home.toString(), 302);
  } catch (err) {
    // ResponseBodyError carries the actual OAuth error/error_description from
    // the token endpoint (e.g. invalid_client, invalid_grant) — surface that
    // instead of a generic message; it's almost always the real cause
    // (redirect_uri mismatch, wrong client auth method, PKCE mismatch, ...).
    let detail = err instanceof Error ? err.message : String(err);
    if (err instanceof client.ResponseBodyError) {
      detail = err.error_description ? `${err.error}: ${err.error_description}` : err.error;
    }
    home.searchParams.set("auth_error", "exchange_failed");
    home.searchParams.set("auth_error_detail", detail);
    console.error("OIDC callback failed:", detail, err);
    return Response.redirect(home.toString(), 302);
  }
}
