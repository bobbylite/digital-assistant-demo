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

  const { region, harnessArn, qualifier, sessionId, messages } = body;

  if (!region || !harnessArn || !sessionId || !Array.isArray(messages) || messages.length === 0) {
    return Response.json(
      { error: "region, harnessArn, sessionId, and a non-empty messages array are required." },
      { status: 400 }
    );
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

  if (!bearerToken) {
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
      "aws.region": region,
      "aws.harness_arn": harnessArn,
      "aws.qualifier": qualifier || "DEFAULT",
      "identity.token_source": tokenSource,
      ...(session?.sub ? { "identity.sub": session.sub } : {}),
    },
  });

  const url =
    `https://bedrock-agentcore.${region}.amazonaws.com/harnesses/invoke` +
    `?harnessArn=${encodeURIComponent(harnessArn)}&qualifier=${encodeURIComponent(qualifier || "DEFAULT")}`;

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
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

      (async () => {
        let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

        try {
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

                // Token usage is the audit-relevant payoff of this whole
                // call — record it on the span the moment AgentCore reports
                // it, same place metrics used to come from client-side.
                if (eventType === "metadata" && payload && typeof payload === "object") {
                  const usage = (payload as { usage?: Record<string, unknown> }).usage;
                  if (usage) {
                    if (typeof usage.inputTokens === "number") span.setAttribute("token.input", usage.inputTokens);
                    if (typeof usage.outputTokens === "number") span.setAttribute("token.output", usage.outputTokens);
                    if (typeof usage.totalTokens === "number") span.setAttribute("token.total", usage.totalTokens);
                  }
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
