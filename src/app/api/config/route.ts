import { getConnectionDefaults } from "@/lib/settings";

// Public, unauthenticated — these are pre-fill values for the Connection
// panel, not secrets (previously NEXT_PUBLIC_*-inlined at build time; now
// served at runtime instead so the Settings panel can change them without a
// rebuild — see CLAUDE.md's Settings section for why).
export const runtime = "nodejs";

export async function GET() {
  return Response.json(getConnectionDefaults());
}
