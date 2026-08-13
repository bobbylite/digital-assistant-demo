import { getRecentSpans, clearSpans } from "@/lib/telemetry";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ spans: getRecentSpans() });
}

export async function DELETE() {
  clearSpans();
  return Response.json({ ok: true });
}
