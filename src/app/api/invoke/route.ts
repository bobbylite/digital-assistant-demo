import { trace, SpanStatusCode } from "@opentelemetry/api";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { toUtf8, fromUtf8 } from "@smithy/util-utf8";
import { getExchangedToken, getUserSession } from "@/lib/auth-session";
import { TRACER_NAME } from "@/lib/telemetry";
import type { InvokeRequestBody } from "@/lib/types";

export const runtime = "nodejs";

const codec = new EventStreamCodec(toUtf8, fromUtf8);
const tracer = trace.getTracer(TRACER_NAME);

function concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function headerValue(
  headers: Record<string, { value: unknown }>,
  name: string
): string | undefined {
  const value = headers[name]?.value;
  return typeof value === "string" ? value : undefined;
}

export async function POST(request: Request) {
  let body: InvokeRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { region, harnessArn, agentRuntimeArn, localAgentUrl, qualifier, sessionId, messages } = body;
  const runtimeMode = body.runtimeMode ?? "harness";

  if (!sessionId || !Array.isArray(messages) || messages.length === 0) {
    return Response.json(
      { error: "sessionId and a non-empty messages array are required." },
      { status: 400 }
    );
  }
  if (runtimeMode === "harness" && (!region || !harnessArn)) {
    return Response.json({ error: "region and harnessArn are required for the harness runtime target." }, { status: 400 });
  }
  if (runtimeMode === "agentRuntime" && (!region || !agentRuntimeArn)) {
    return Response.json(
      { error: "region and agentRuntimeArn are required for the agentRuntime runtime target." },
      { status: 400 }
    );
  }
  if (runtimeMode === "local" && !localAgentUrl) {
    return Response.json({ error: "localAgentUrl is required for the local runtime target." }, { status: 400 });
  }

  // Priority: RFC 8693 exchanged token (carries both the real user's
  // identity and the agent's own client_id — the token AgentCore's
  // authorizer actually wants) > plain OIDC session token > manually pasted
  // JWT. Each is server-verified and never exposed to the browser except
  // the last, which the user typed in themselves. This is the only place
  // any of them exists in memory, for exactly as long as this request takes.
  const [exchanged, session] = await Promise.all([getExchangedToken(), getUserSession()]);
  const bearerToken = exchanged?.accessToken ?? session?.accessToken ?? body.jwt;
  const tokenSource = exchanged?.accessToken ? "exchanged" : session?.accessToken ? "session" : "manual";

  // The local dev agent has no JWT authorizer configured (that only exists
  // once deployed to AWS — see agent/README.md), so it's fine to invoke it
  // anonymously for a quick local loop; the harness/agentRuntime targets
  // always require a real bearer token.
  if (!bearerToken && runtimeMode !== "local") {
    return Response.json(
      { error: "No JWT provided and no signed-in session — sign in or paste a bearer JWT." },
      { status: 401 }
    );
  }

  // Spans this route in particular an audit trail: which credential path
  // served this call, against which harness, with what token usage. The
  // span has to outlive this function — it doesn't end until the streamed
  // response finishes downstream, well after this handler returns the
  // Response object — so it's a manual tracer.startSpan(), not the withSpan
  // helper (which assumes the traced work finishes before returning).
  const span = tracer.startSpan("agentcore.invoke", {
    attributes: {
      "agentcore.runtime_mode": runtimeMode,
      ...(region ? { "aws.region": region } : {}),
      ...(runtimeMode === "harness" ? { "aws.harness_arn": harnessArn! } : {}),
      ...(runtimeMode === "agentRuntime" ? { "aws.agent_runtime_arn": agentRuntimeArn! } : {}),
      ...(runtimeMode === "local" ? { "agentcore.local_agent_url": localAgentUrl! } : {}),
      ...(runtimeMode !== "local" ? { "aws.qualifier": qualifier || "DEFAULT" } : {}),
      "identity.token_source": tokenSource,
      ...(session?.sub ? { "identity.sub": session.sub } : {}),
    },
  });

  // Harness (InvokeHarness): ARN is a query param. Custom AgentCore Runtime
  // (InvokeAgentRuntime): ARN is escaped into the path instead — genuinely
  // different, not a typo, confirmed against AWS's devguide. Local: this
  // app's own custom agent running via `python main.py` (see agent/),
  // serving the identical /invocations contract a deployed Runtime does.
  const url =
    runtimeMode === "harness"
      ? `https://bedrock-agentcore.${region}.amazonaws.com/harnesses/invoke` +
        `?harnessArn=${encodeURIComponent(harnessArn!)}&qualifier=${encodeURIComponent(qualifier || "DEFAULT")}`
      : runtimeMode === "agentRuntime"
        ? `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(agentRuntimeArn!)}/invocations` +
          `?qualifier=${encodeURIComponent(qualifier || "DEFAULT")}`
        : `${localAgentUrl!.replace(/\/+$/, "")}/invocations`;

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        "Content-Type": "application/json",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
      },
      body: JSON.stringify({ messages }),
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();
    return Response.json({ error: `Failed to reach AgentCore: ${error.message}` }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    let message = text || `Upstream returned HTTP ${upstream.status}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || parsed.error || message;
    } catch {
      // upstream error body wasn't JSON; fall back to raw text
    }
    span.setStatus({ code: SpanStatusCode.ERROR, message });
    span.setAttribute("http.status_code", upstream.status);
    span.end();
    return Response.json({ error: message }, { status: upstream.status });
  }

  const upstreamReader = upstream.body.getReader();
  const encoder = new TextEncoder();
  let spanEnded = false;
  const endSpan = (code: SpanStatusCode, message?: string) => {
    if (spanEnded) return;
    spanEnded = true;
    span.setStatus({ code, message });
    span.end();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (type: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Records token usage on the span the moment either upstream shape
      // reports it — same audit-relevant payoff, two different wire formats.
      const recordUsage = (usage: unknown) => {
        if (!usage || typeof usage !== "object") return;
        const u = usage as Record<string, unknown>;
        if (typeof u.inputTokens === "number") span.setAttribute("token.input", u.inputTokens);
        if (typeof u.outputTokens === "number") span.setAttribute("token.output", u.outputTokens);
        if (typeof u.totalTokens === "number") span.setAttribute("token.total", u.totalTokens);
      };

      const decodeHarnessStream = async () => {
        let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

        while (true) {
          const { done, value } = await upstreamReader.read();
          if (done) break;
          buffer = concat(buffer, value);

          while (buffer.length >= 4) {
            const totalLength = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0, false);
            if (buffer.length < totalLength) break;

            const messageBytes = buffer.slice(0, totalLength);
            buffer = buffer.slice(totalLength);

            try {
              const decoded = codec.decode(messageBytes);
              const eventType = headerValue(decoded.headers, ":event-type") ?? headerValue(decoded.headers, "event-type");
              const messageType =
                headerValue(decoded.headers, ":message-type") ?? headerValue(decoded.headers, "message-type");
              const bodyText = toUtf8(decoded.body);

              let payload: unknown;
              try {
                payload = bodyText ? JSON.parse(bodyText) : {};
              } catch {
                payload = { raw: bodyText };
              }

              if (eventType === "metadata" && payload && typeof payload === "object") {
                recordUsage((payload as { usage?: unknown }).usage);
              }

              if (messageType === "exception") {
                span.setAttribute("agentcore.error_type", eventType ?? "unknown");
                send("agent-error", { eventType, ...(payload as object) });
              } else {
                send(eventType || "unknown", payload);
              }
            } catch (err) {
              send("stream-error", { message: err instanceof Error ? err.message : String(err) });
            }
          }
        }
      };

      // The custom agent (agentRuntime/local) speaks real text/event-stream
      // SSE (`data: {...}\n\n` lines), not AWS's binary event-stream framing
      // — that framing is harness-specific. Our own agent (see agent/main.py)
      // already normalizes its events to this app's {"type": ..., ...}
      // shape, so this is a straight relay, not a protocol decode.
      const decodeCustomAgentStream = async () => {
        const decoder = new TextDecoder();
        let textBuffer = "";

        while (true) {
          const { done, value } = await upstreamReader.read();
          if (done) break;
          textBuffer += decoder.decode(value, { stream: true });

          let boundary = textBuffer.indexOf("\n\n");
          while (boundary !== -1) {
            const rawBlock = textBuffer.slice(0, boundary);
            textBuffer = textBuffer.slice(boundary + 2);
            boundary = textBuffer.indexOf("\n\n");

            const dataLine = rawBlock.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;

            let payload: unknown;
            try {
              payload = JSON.parse(dataLine.slice("data: ".length));
            } catch {
              payload = {};
            }
            const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
            // Our own agent-error type, or the SDK's own generic
            // {"error", "error_type", "message"} shape on an unhandled
            // exception escaping the entrypoint — either way, surface it as
            // agent-error so the client's existing handling catches it.
            const type = typeof obj.type === "string" ? obj.type : obj.error ? "agent-error" : "unknown";

            if (type === "metadata") recordUsage(obj.usage);
            if (type === "agent-error") span.setAttribute("agentcore.error_type", type);

            send(type, obj);
          }
        }
      };

      (async () => {
        try {
          if (runtimeMode === "harness") {
            await decodeHarnessStream();
          } else {
            await decodeCustomAgentStream();
          }
          endSpan(SpanStatusCode.OK);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send("stream-error", { message });
          endSpan(SpanStatusCode.ERROR, message);
        } finally {
          send("done", {});
          controller.close();
        }
      })();
    },
    cancel() {
      upstreamReader.cancel().catch(() => {});
      endSpan(SpanStatusCode.ERROR, "Client disconnected before the stream finished.");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
