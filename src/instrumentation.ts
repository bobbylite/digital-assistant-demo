// Next.js convention: register() runs once when the server starts, before
// it handles any requests. Lives inside src/ (alongside app/) per Next's own
// rule for projects using a src folder — see CLAUDE.md's OpenTelemetry
// section for why this exists and what it does (and doesn't) send anywhere.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initTelemetry } = await import("@/lib/telemetry");
    initTelemetry();
  }
}
