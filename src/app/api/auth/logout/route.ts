import * as client from "openid-client";
import { getOidcConfiguration, getOidcEnv, isOidcConfigured } from "@/lib/oidc";
import { clearUserSession, clearPendingLogin, getUserSession } from "@/lib/auth-session";

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

  try {
    const config = await getOidcConfiguration();
    if (!config.serverMetadata().end_session_endpoint) {
      // IdP doesn't advertise RP-Initiated Logout support — local logout
      // above is all we can do.
      return Response.redirect(home.toString(), 302);
    }

    const env = getOidcEnv();
    const endSessionUrl = client.buildEndSessionUrl(config, {
      id_token_hint: session.idToken,
      post_logout_redirect_uri: env.postLogoutRedirectUri,
    });
    return Response.redirect(endSessionUrl.toString(), 302);
  } catch (err) {
    // Most likely cause: post_logout_redirect_uri isn't registered as a
    // "Sign Off URL" on the PingOne application. Local session is already
    // cleared above regardless, so fail soft rather than stranding the user.
    console.error("RP-initiated logout failed, local session was still cleared:", err instanceof Error ? err.message : err);
    return Response.redirect(home.toString(), 302);
  }
}
