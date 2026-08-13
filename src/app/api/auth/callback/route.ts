import * as client from "openid-client";
import { getOidcConfiguration, isOidcConfigured } from "@/lib/oidc";
import { getAndClearPendingLogin, setUserSession } from "@/lib/auth-session";
import { withSpan } from "@/lib/telemetry";

export const runtime = "nodejs";

// Lets every failure branch below throw (and so get recorded on the span as
// a real ERROR status via withSpan's catch) while still mapping cleanly
// back to the existing auth_error query-param codes at the one place that
// builds the redirect.
class CallbackError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string
  ) {
    super(message);
  }
}

export async function GET(request: Request) {
  const home = new URL("/", request.url);

  if (!isOidcConfigured()) {
    home.searchParams.set("auth_error", "not_configured");
    return Response.redirect(home.toString(), 302);
  }

  try {
    await withSpan("oidc.login.callback", {}, async (span) => {
      const pending = await getAndClearPendingLogin();
      if (!pending) {
        // Missing/expired/already-used pending cookie — could be a stale
        // tab, a replayed callback, or a CSRF attempt. Fail closed either way.
        throw new CallbackError("expired_login", "Pending login cookie missing or already used");
      }

      let config: client.Configuration;
      try {
        config = await getOidcConfiguration();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error("OIDC discovery failed:", detail);
        throw new CallbackError("discovery_failed", "OIDC discovery failed", detail);
      }

      try {
        // Validates `state`, exchanges the code at the token endpoint (with
        // our PKCE code_verifier), and verifies the ID token's signature
        // (via JWKS from discovery), issuer, audience, expiry, and `nonce`
        // — all inside this one call. This is the whole reason to use
        // openid-client instead of hand-rolling the token exchange: none of
        // those checks are optional for security, and they're easy to get
        // subtly wrong by hand.
        const tokens = await client.authorizationCodeGrant(config, new URL(request.url), {
          expectedState: pending.state,
          expectedNonce: pending.nonce,
          pkceCodeVerifier: pending.codeVerifier,
        });

        const claims = tokens.claims();
        const sub = claims?.sub;
        if (!sub || !tokens.access_token) {
          throw new CallbackError("incomplete_response", "Token endpoint response missing sub or access_token");
        }

        // Identity claim only — never the token itself. This is the audit
        // trail entry for "who signed in, when."
        span.setAttribute("identity.sub", sub);
        const expiresIn = tokens.expiresIn();
        if (expiresIn !== undefined) span.setAttribute("token.expires_in_s", expiresIn);

        await setUserSession(
          {
            accessToken: tokens.access_token,
            idToken: tokens.id_token,
            sub,
            name: typeof claims?.name === "string" ? claims.name : undefined,
            email: typeof claims?.email === "string" ? claims.email : undefined,
          },
          expiresIn
        );
      } catch (err) {
        if (err instanceof CallbackError) throw err;
        // ResponseBodyError carries the actual OAuth error/error_description
        // from the token endpoint (e.g. invalid_client, invalid_grant) —
        // surface that instead of a generic message; it's almost always the
        // real cause (redirect_uri mismatch, wrong client auth method, PKCE
        // mismatch, ...).
        let detail = err instanceof Error ? err.message : String(err);
        if (err instanceof client.ResponseBodyError) {
          detail = err.error_description ? `${err.error}: ${err.error_description}` : err.error;
        }
        console.error("OIDC callback failed:", detail, err);
        throw new CallbackError("exchange_failed", "Token exchange failed", detail);
      }
    });

    return Response.redirect(home.toString(), 302);
  } catch (err) {
    if (err instanceof CallbackError) {
      home.searchParams.set("auth_error", err.code);
      if (err.detail) home.searchParams.set("auth_error_detail", err.detail);
    } else {
      home.searchParams.set("auth_error", "exchange_failed");
    }
    return Response.redirect(home.toString(), 302);
  }
}
