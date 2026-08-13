// Container-orchestrator health check (Docker HEALTHCHECK, Compose,
// eventually an ECS/Kubernetes liveness probe). Deliberately dumb — no
// auth, no downstream calls to PingOne or AWS — this only answers "is the
// Next.js server process up and routing requests," not "is AgentCore
// reachable." Keep it that narrow; a health check that depends on a third
// party turns their outage into this container's outage too.
export const runtime = "nodejs";

export async function GET() {
  return Response.json({ status: "ok" });
}
