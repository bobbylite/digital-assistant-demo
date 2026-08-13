import * as client from "openid-client";
import { getOidcConfiguration, getOidcEnv, isOidcConfigured } from "@/lib/oidc";
import { setPendingLogin } from "@/lib/auth-session";
import { withSpan } from "@/lib/telemetry";

export const runtime = "nodejs";

export async function GET() {
  if (!isOidcConfigured()) {
    return Response.json({ error: "OIDC is not configured on this server. See .env.local.example." }, { status: 501 });
  }

  const env = getOidcEnv();

  try {
    const authorizationUrl = await withSpan(
      "oidc.login.redirect",
      { "identity.client_id": env.clientId, "identity.scope": env.scopes },
      async () => {
        const config = await getOidcConfiguration();

        // Fresh, random, single-use — required every authorization request, never reused.
        const codeVerifier = client.randomPKCECodeVerifier();
        const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
        const state = client.randomState();
        const nonce = client.randomNonce();

        await setPendingLogin({ codeVerifier, state, nonce });

        return client.buildAuthorizationUrl(config, {
          redirect_uri: env.redirectUri,
          scope: env.scopes,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state,
          nonce,
        });
      }
    );

    return Response.redirect(authorizationUrl.toString(), 302);
  } catch (err) {
    return Response.json(
      { error: `Failed to discover OIDC configuration: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}
