import * as client from "openid-client";
import { getOidcConfiguration, getOidcEnv, isOidcConfigured } from "@/lib/oidc";
import { clearUserSession, clearPendingLogin, getUserSession } from "@/lib/auth-session";
import { withSpan } from "@/lib/telemetry";

export const runtime = "nodejs";

// GET, not POST: signing out has to end in a full top-level browser
// navigation to PingOne's own end-session endpoint (RP-Initiated Logout),
// or the IdP's SSO session survives and the next "sign in" click silently
// re-authenticates through it instead of showing a real login prompt. A
// background fetch can't do that — only the browser itself, carrying
// PingOne's own cookies, can.
export async function GET(request: Request) {
  const home = new URL("/", request.url);

  // Read the id_token BEFORE clearing — need it as id_token_hint so PingOne
  // knows which session to end. Local logout happens unconditionally and
  // first: even if everything past this point fails, the user is signed out
  // of this app.
  const session = await getUserSession();
  await clearUserSession();
  await clearPendingLogin();

  if (!isOidcConfigured() || !session?.idToken) {
    return Response.redirect(home.toString(), 302);
  }
  // Narrowed to a local const: TypeScript can't carry the `session.idToken`
  // truthiness check above into the closure below (property narrowing
  // doesn't survive a closure boundary), but a locally-bound const does.
  const idToken = session.idToken;

  try {
    const endSessionUrl = await withSpan(
      "oidc.logout",
      { "identity.sub": session.sub },
      async (span) => {
        const config = await getOidcConfiguration();
        if (!config.serverMetadata().end_session_endpoint) {
          // IdP doesn't advertise RP-Initiated Logout support — not an
          // error, just nothing more to do; note it on the span and let the
          // route fall back to local-only logout below.
          span.setAttribute("logout.rp_initiated", false);
          return null;
        }

        const env = getOidcEnv();
        span.setAttribute("logout.rp_initiated", true);
        return client.buildEndSessionUrl(config, {
          id_token_hint: idToken,
          post_logout_redirect_uri: env.postLogoutRedirectUri,
        });
      }
    );

    return Response.redirect((endSessionUrl ?? home).toString(), 302);
  } catch (err) {
    // Most likely cause: post_logout_redirect_uri isn't registered as a
    // "Sign Off URL" on the PingOne application. Local session is already
    // cleared above regardless, so fail soft rather than stranding the user
    // — the span this threw from is still recorded as an ERROR for the
    // audit trail even though the user experience stays graceful.
    console.error("RP-initiated logout failed, local session was still cleared:", err instanceof Error ? err.message : err);
    return Response.redirect(home.toString(), 302);
  }
}
