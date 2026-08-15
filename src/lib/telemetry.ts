import { trace, SpanStatusCode, SpanKind, type Span } from "@opentelemetry/api";
import { NodeTracerProvider, type SpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { RecordedSpan } from "@/lib/types";

/**
 * Server-only. Real OpenTelemetry spans for every identity/token operation
 * in this app (OIDC login/callback, agent client-credentials, RFC 8693
 * exchange, the AgentCore invoke call) — not a fake/simulated timeline. No
 * real OTel collector is configured (there's nowhere to point one at by
 * default), so spans are kept in an in-memory ring buffer here and also
 * printed to the console — both real, just local. Point `initTelemetry()`
 * at a real OTLP exporter (`@opentelemetry/exporter-trace-otlp-http`)
 * instead/in addition if you want this to leave the process — see CLAUDE.md.
 */

export const TRACER_NAME = "agentcore-console";
const MAX_SPANS = 300;

// Next.js/Turbopack can load instrumentation.ts (where initTelemetry() runs)
// and the various route handlers (where getRecentSpans()/withSpan() get
// called) as *separate module instances* in dev mode — a plain module-level
// `const recentSpans = []` would then silently split into multiple
// independent arrays, so spans recorded by the processor would never be
// visible to the route that reads them back (this happened; it's why the
// buffer lives on globalThis instead, the standard workaround for this
// class of Next.js dev-mode singleton problem — same trick commonly used
// for a Prisma client singleton).
declare global {
  var __agentcoreRecentSpans: RecordedSpan[] | undefined;
}

function spanStore(): RecordedSpan[] {
  if (!globalThis.__agentcoreRecentSpans) {
    globalThis.__agentcoreRecentSpans = [];
  }
  return globalThis.__agentcoreRecentSpans;
}

function hrTimeToMs(t: readonly [number, number]): number {
  return t[0] * 1000 + t[1] / 1e6;
}

// Defense in depth: withSpan() below only ever accepts an explicit allowlist
// of safe attributes, so nothing token-shaped should reach a span in the
// first place. This is a second, independent gate at export time in case a
// future edit sets an attribute directly on a Span some other way — any
// attribute key that even *looks* like it might hold a secret is dropped
// before it ever lands in the in-memory store or console output.
const SUSPICIOUS_KEY_PATTERN = /token|secret|password|authoriz/i;
// Known-safe keys that happen to contain "token" as a substring without
// holding a credential value (a usage count, or the name of which
// credential path served a request) — exempted explicitly rather than
// narrowing the pattern above, so it still catches anything unanticipated.
const SAFE_KEY_ALLOWLIST = new Set(["token.input", "token.output", "token.total", "identity.token_source"]);

// Registering a global TracerProvider (below) also switches on Next.js's
// *own* built-in OpenTelemetry instrumentation — spans like "resolve page
// components" or "render route" start flowing through here too, from a
// different instrumentationScope ("next.js"). That's authentic OTel
// behavior, not a bug, but it's framework noise relative to what this panel
// is for — it would flood both the console and the in-memory store and bury
// the identity/audit spans this app actually cares about. Every span this
// app creates itself goes through tracer.getTracer(TRACER_NAME) below, so
// filtering on instrumentationScope.name here keeps only those.
class RecordingSpanProcessor implements SpanProcessor {
  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    if (span.instrumentationScope.name !== TRACER_NAME) return;

    const ctx = span.spanContext();
    const attributes: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(span.attributes)) {
      if (!SAFE_KEY_ALLOWLIST.has(key) && SUSPICIOUS_KEY_PATTERN.test(key)) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        attributes[key] = value;
      }
    }

    const status: RecordedSpan["status"] =
      span.status.code === SpanStatusCode.ERROR ? "ERROR" : span.status.code === SpanStatusCode.OK ? "OK" : "UNSET";

    const store = spanStore();
    store.push({
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: span.parentSpanContext?.spanId,
      name: span.name,
      startTimeMs: hrTimeToMs(span.startTime),
      status,
      statusMessage: span.status.message,
      attributes,
    });

    if (store.length > MAX_SPANS) {
      store.splice(0, store.length - MAX_SPANS);
    }

    // Compact one-line console mirror — real OTel data, just not the
    // (very verbose) default ConsoleSpanExporter format, and only for this
    // app's own spans, not Next's internal ones.
    const attrText = Object.entries(attributes)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`[otel] ${status === "ERROR" ? "✗" : "✓"} ${span.name} ${attrText}`.trimEnd());
  }

  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

let initialized = false;

/** Called once from instrumentation.ts at server startup. */
export function initTelemetry(): void {
  if (initialized) return;
  initialized = true;

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: TRACER_NAME }),
    spanProcessors: [new RecordingSpanProcessor()],
  });
  provider.register();
}

/** Newest first — what the UI and the /api/telemetry/spans route want. */
export function getRecentSpans(): RecordedSpan[] {
  return [...spanStore()].reverse();
}

export function clearSpans(): void {
  spanStore().length = 0;
}

const tracer = trace.getTracer(TRACER_NAME);

/**
 * Every span in this app goes through here. `attributes` is a plain object,
 * not a free-form bag pulled from request/response data — keep it that way.
 * Never pass a token, secret, or raw Authorization header value as an
 * attribute; identity *claims* (sub, client_id, scope) are fine, the
 * credentials that carried them are not.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(name, { kind: SpanKind.CLIENT }, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
