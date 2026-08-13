import { getUserSession } from "@/lib/auth-session";
import { applySettings, getRedactedSettings, type SettingsInput } from "@/lib/settings";
import { withSpan } from "@/lib/telemetry";

export const runtime = "nodejs";

// Gated on being signed in — same bar as "Authenticate Agent" already uses
// elsewhere in this app. There's no separate admin/role concept here (this
// is a single-operator console, not multi-tenant), so "authenticated at
// all" is the whole check, deliberately. What this guards is real, though:
// AGENT_CLIENT_ID and (via POST) AGENT_CLIENT_SECRET.
async function requireSession() {
  const session = await getUserSession();
  if (!session) {
    return null;
  }
  return session;
}

export async function GET() {
  const session = await requireSession();
  if (!session) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  return Response.json(getRedactedSettings());
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }

  let body: SettingsInput;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  try {
    const result = await withSpan(
      "settings.update",
      {
        "identity.sub": session.sub,
        "settings.fields": Object.keys(body).join(","),
      },
      async () => applySettings(body)
    );
    return Response.json({ ok: true, ...result, settings: getRedactedSettings() });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
