import { EventStreamCodec } from "@smithy/eventstream-codec";
import { toUtf8, fromUtf8 } from "@smithy/util-utf8";
import type { InvokeRequestBody } from "@/lib/types";

export const runtime = "nodejs";

const codec = new EventStreamCodec(toUtf8, fromUtf8);

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

  const { jwt, region, harnessArn, qualifier, sessionId, messages } = body;

  if (!jwt || !region || !harnessArn || !sessionId || !Array.isArray(messages) || messages.length === 0) {
    return Response.json(
      { error: "jwt, region, harnessArn, sessionId, and a non-empty messages array are required." },
      { status: 400 }
    );
  }

  const url =
    `https://bedrock-agentcore.${region}.amazonaws.com/harnesses/invoke` +
    `?harnessArn=${encodeURIComponent(harnessArn)}&qualifier=${encodeURIComponent(qualifier || "DEFAULT")}`;

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
      },
      body: JSON.stringify({ messages }),
    });
  } catch (err) {
    return Response.json(
      { error: `Failed to reach AgentCore: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
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
    return Response.json({ error: message }, { status: upstream.status });
  }

  const upstreamReader = upstream.body.getReader();
  const encoder = new TextEncoder();

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

                if (messageType === "exception") {
                  send("agent-error", { eventType, ...(payload as object) });
                } else {
                  send(eventType || "unknown", payload);
                }
              } catch (err) {
                send("stream-error", { message: err instanceof Error ? err.message : String(err) });
              }
            }
          }
        } catch (err) {
          send("stream-error", { message: err instanceof Error ? err.message : String(err) });
        } finally {
          send("done", {});
          controller.close();
        }
      })();
    },
    cancel() {
      upstreamReader.cancel().catch(() => {});
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
