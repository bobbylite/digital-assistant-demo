import { isAgentConfigured, isOidcConfigured } from "@/lib/oidc";
import { getAgentToken, getUserSession } from "@/lib/auth-session";
import type { AuthSession } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const [session, agentToken] = await Promise.all([getUserSession(), getAgentToken()]);

  // Deliberately never includes accessToken (user's) or the agent's own
  // token — this is the only session data the browser gets to see, and
  // it's just enough to render "signed in as X" / the right buttons. Both
  // real tokens stay server-side.
  const body: AuthSession = {
    oidcEnabled: isOidcConfigured(),
    authenticated: Boolean(session),
    sub: session?.sub,
    name: session?.name,
    email: session?.email,
    agentConfigured: isAgentConfigured(),
    agentAuthenticated: Boolean(agentToken),
  };

  return Response.json(body);
}
