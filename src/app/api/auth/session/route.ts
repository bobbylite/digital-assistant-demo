import { isOidcConfigured } from "@/lib/oidc";
import { getUserSession } from "@/lib/auth-session";
import type { AuthSession } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const session = await getUserSession();

  // Deliberately never includes accessToken — this is the only session
  // data the browser gets to see, and it's just enough to render "signed
  // in as X" / show the right button. The real token stays server-side.
  const body: AuthSession = {
    oidcEnabled: isOidcConfigured(),
    authenticated: Boolean(session),
    sub: session?.sub,
    name: session?.name,
    email: session?.email,
  };

  return Response.json(body);
}
