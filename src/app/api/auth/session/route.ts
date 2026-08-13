import { isAgentConfigured, isOidcConfigured } from "@/lib/oidc";
import { getExchangedToken, getUserSession } from "@/lib/auth-session";
import type { AuthSession } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const [session, exchangedToken] = await Promise.all([getUserSession(), getExchangedToken()]);

  // Deliberately never includes accessToken (user's), the agent's own
  // client-credentials token, or the exchanged token — this is the only
  // session data the browser gets to see, and it's just enough to render
  // "signed in as X" / the right buttons. All real tokens stay server-side.
  const body: AuthSession = {
    oidcEnabled: isOidcConfigured(),
    authenticated: Boolean(session),
    sub: session?.sub,
    name: session?.name,
    email: session?.email,
    agentConfigured: isAgentConfigured(),
    // "Authenticated" here means the *whole* flow succeeded — client
    // credentials grant AND the RFC 8693 exchange — not just the first
    // half. A raw agent token with no exchanged token means the button
    // returned an error, which the UI already surfaces separately; this
    // flag is specifically "is there a token ready to use against AgentCore."
    agentAuthenticated: Boolean(exchangedToken),
  };

  return Response.json(body);
}
