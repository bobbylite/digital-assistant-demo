import * as client from "openid-client";
import { getAgentConfiguration, getAgentEnv, isAgentConfigured } from "@/lib/oidc";
import { setAgentToken } from "@/lib/auth-session";

export const runtime = "nodejs";

// POST, not a redirect-based GET like /login: Client Credentials Grant is a
// pure back-channel exchange — the agent authenticates directly to the
// token endpoint with its own client_id/secret, no browser round trip, no
// user, no consent screen. The browser just waits on this fetch and gets a
// plain ok/error back; the resulting token never appears in the response
// body, only inside the encrypted cookie this sets.
export async function POST() {
  if (!isAgentConfigured()) {
    return Response.json(
      { error: "Agent client credentials are not configured on this server. See .env.local.example." },
      { status: 501 }
    );
  }

  let config: client.Configuration;
  try {
    config = await getAgentConfiguration();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("Agent OIDC discovery failed:", detail);
    return Response.json({ error: `Failed to discover OIDC configuration: ${detail}` }, { status: 502 });
  }

  const env = getAgentEnv();

  try {
    const tokens = await client.clientCredentialsGrant(config, { scope: env.scope });

    if (!tokens.access_token) {
      return Response.json({ error: "Token endpoint response had no access_token." }, { status: 502 });
    }

    await setAgentToken({ accessToken: tokens.access_token }, tokens.expiresIn());
    return Response.json({ ok: true });
  } catch (err) {
    // Same reasoning as the user-login callback: surface the actual OAuth
    // error/error_description (invalid_client, invalid_scope, ...) instead
    // of a generic message — it's almost always the real cause.
    let detail = err instanceof Error ? err.message : String(err);
    if (err instanceof client.ResponseBodyError) {
      detail = err.error_description ? `${err.error}: ${err.error_description}` : err.error;
    }
    console.error("Agent client_credentials grant failed:", detail, err);
    return Response.json({ error: detail }, { status: 502 });
  }
}
