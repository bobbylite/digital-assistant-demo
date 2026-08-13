import * as client from "openid-client";
import { getAgentConfiguration, getAgentEnv, isAgentConfigured } from "@/lib/oidc";
import { getUserSession, setAgentToken, setExchangedToken } from "@/lib/auth-session";
import { withSpan } from "@/lib/telemetry";

export const runtime = "nodejs";

const TOKEN_TYPE_ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token";
const GRANT_TYPE_TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";

function oauthErrorDetail(err: unknown): string {
  if (err instanceof client.ResponseBodyError) {
    return err.error_description ? `${err.error}: ${err.error_description}` : err.error;
  }
  return err instanceof Error ? err.message : String(err);
}

// Carries the HTTP status this route should respond with, so the span tree
// below can just throw on failure (recorded as a real ERROR span) without
// losing the specific status code/message each failure mode already had.
class AgentAuthError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

// POST, not a redirect-based GET like /login: both Client Credentials Grant
// and the RFC 8693 exchange that follows it are pure back-channel calls —
// the agent authenticates directly to the token endpoint, no browser round
// trip, no user interaction. The browser just waits on this fetch and gets
// a plain ok/error back; neither resulting token ever appears in the
// response body, only inside their respective encrypted cookies.
export async function POST() {
  if (!isAgentConfigured()) {
    return Response.json(
      { error: "Agent client credentials are not configured on this server. See .env.local.example." },
      { status: 501 }
    );
  }

  // The exchange needs a subject_token — your own OIDC session — so there's
  // nothing useful this route can do without one. Fail fast rather than
  // spend a client_credentials round trip on a flow that can't finish.
  const userSession = await getUserSession();
  if (!userSession) {
    return Response.json(
      { error: "Sign in with PingOne first — token exchange needs your session's access token as the subject." },
      { status: 400 }
    );
  }

  try {
    await withSpan("agent.authenticate", { "identity.sub": userSession.sub }, async () => {
      let config: client.Configuration;
      try {
        config = await getAgentConfiguration();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error("Agent OIDC discovery failed:", detail);
        throw new AgentAuthError(`Failed to discover OIDC configuration: ${detail}`, 502);
      }

      const env = getAgentEnv();

      // Step 1: Client Credentials Grant — the agent authenticates as
      // itself to get its own token (the actor_token for the exchange below).
      const actorToken = await withSpan(
        "agent.client_credentials",
        { "identity.client_id": env.clientId, "identity.scope": env.scope },
        async () => {
          let tokens;
          try {
            tokens = await client.clientCredentialsGrant(config, { scope: env.scope });
          } catch (err) {
            const detail = oauthErrorDetail(err);
            console.error("Agent client_credentials grant failed:", detail, err);
            throw new AgentAuthError(detail, 502);
          }
          if (!tokens.access_token) {
            throw new AgentAuthError("Token endpoint response had no access_token (client_credentials).", 502);
          }
          // Stored regardless of whether the exchange below succeeds — this
          // part did succeed, and the raw agent token remains independently valid.
          await setAgentToken({ accessToken: tokens.access_token }, tokens.expiresIn());
          return tokens.access_token;
        }
      );

      // Step 2: RFC 8693 Token Exchange — combine the user's token
      // (subject) with the agent's token (actor) into one delegated token
      // carrying both identities. No dedicated openid-client helper for
      // this grant type (it's not one of the common ones like
      // authorization_code/refresh_token), so genericGrantRequest sends
      // the raw grant per RFC 8693 directly.
      await withSpan(
        "agent.token_exchange",
        {
          "identity.subject_sub": userSession.sub,
          "identity.actor_client_id": env.clientId,
          "identity.scope": env.exchangeScope,
          "token.requested_type": "access_token",
        },
        async () => {
          let exchanged;
          try {
            exchanged = await client.genericGrantRequest(config, GRANT_TYPE_TOKEN_EXCHANGE, {
              subject_token: userSession.accessToken,
              subject_token_type: TOKEN_TYPE_ACCESS_TOKEN,
              actor_token: actorToken,
              actor_token_type: TOKEN_TYPE_ACCESS_TOKEN,
              requested_token_type: TOKEN_TYPE_ACCESS_TOKEN,
              scope: env.exchangeScope,
            });
          } catch (err) {
            const detail = oauthErrorDetail(err);
            console.error("RFC 8693 token exchange failed:", detail, err);
            // Client credentials succeeded even though the exchange didn't —
            // say so, since "Agent authenticated" would otherwise be a
            // confusing thing to see paired with an error.
            throw new AgentAuthError(`Agent authenticated, but token exchange failed: ${detail}`, 502);
          }
          if (!exchanged.access_token) {
            throw new AgentAuthError("Token endpoint response had no access_token (token-exchange).", 502);
          }
          await setExchangedToken({ accessToken: exchanged.access_token }, exchanged.expiresIn());
        }
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof AgentAuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
