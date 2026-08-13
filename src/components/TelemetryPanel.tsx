"use client";

import { useCallback, useEffect, useState } from "react";
import { Panel } from "./Panel";
import type { RecordedSpan } from "@/lib/types";

const SPAN_LABELS: Record<string, string> = {
  "oidc.login.redirect": "Sign-in redirect",
  "oidc.login.callback": "Sign-in callback",
  "oidc.logout": "Sign-out",
  "agent.authenticate": "Agent authenticate",
  "agent.client_credentials": "Client credentials grant",
  "agent.token_exchange": "Token exchange (RFC 8693)",
  "agentcore.invoke": "AgentCore invoke",
};

function labelFor(name: string): string {
  return SPAN_LABELS[name] ?? name;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Short, human labels for the attribute keys each span sets — see
// src/lib/telemetry.ts call sites for the source of truth on what exists.
const ATTRIBUTE_LABELS: Record<string, string> = {
  "identity.sub": "sub",
  "identity.client_id": "client_id",
  "identity.scope": "scope",
  "identity.subject_sub": "subject",
  "identity.actor_client_id": "actor",
  "identity.token_source": "source",
  "token.input": "in",
  "token.output": "out",
  "token.total": "total",
  "token.expires_in_s": "expires(s)",
  "token.requested_type": "requested",
  "aws.region": "region",
  "aws.harness_arn": "harness",
  "aws.qualifier": "qualifier",
  "logout.rp_initiated": "rp-logout",
  "agentcore.error_type": "error_type",
  "http.status_code": "http",
};

function isTokenAttr(key: string): boolean {
  return key.startsWith("token.input") || key.startsWith("token.output") || key.startsWith("token.total");
}

function SpanRow({ span, indent }: { span: RecordedSpan; indent: boolean }) {
  const isError = span.status === "ERROR";
  const entries = Object.entries(span.attributes);
  const tokenAttrs = entries.filter(([k]) => isTokenAttr(k));
  const otherAttrs = entries.filter(([k]) => !isTokenAttr(k));

  return (
    <div
      className={`border-l-2 py-1.5 pl-2.5 ${indent ? "ml-3" : ""} ${isError ? "border-danger" : "border-success/50"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isError ? "bg-danger" : "bg-success"}`} />
          {labelFor(span.name)}
        </div>
        <span className="shrink-0 text-[10px] text-ink-muted">{formatTime(span.startTimeMs)}</span>
      </div>

      {isError && span.statusMessage && <p className="mt-0.5 text-[11px] text-danger">{span.statusMessage}</p>}

      {(otherAttrs.length > 0 || tokenAttrs.length > 0) && (
        <div className="mt-1 flex flex-wrap gap-1">
          {otherAttrs.map(([k, v]) => (
            <span key={k} className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
              {ATTRIBUTE_LABELS[k] ?? k}={String(v)}
            </span>
          ))}
          {tokenAttrs.map(([k, v]) => (
            <span key={k} className="rounded bg-brand-light px-1.5 py-0.5 font-mono text-[10px] font-semibold text-brand">
              {ATTRIBUTE_LABELS[k] ?? k} {String(v)}
            </span>
          ))}
        </div>
      )}

      <p className="mt-1 font-mono text-[9px] text-ink-muted/70">
        trace {span.traceId.slice(0, 8)} · span {span.spanId.slice(0, 8)}
      </p>
    </div>
  );
}

interface TraceGroup {
  traceId: string;
  root: RecordedSpan | null;
  children: RecordedSpan[];
}

function groupByTrace(spans: RecordedSpan[]): TraceGroup[] {
  const byTrace = new Map<string, RecordedSpan[]>();
  for (const span of spans) {
    const list = byTrace.get(span.traceId) ?? [];
    list.push(span);
    byTrace.set(span.traceId, list);
  }

  const groups: TraceGroup[] = [];
  for (const [traceId, traceSpans] of byTrace) {
    const spanIds = new Set(traceSpans.map((s) => s.spanId));
    const root = traceSpans.find((s) => !s.parentSpanId || !spanIds.has(s.parentSpanId)) ?? traceSpans[0] ?? null;
    const children = traceSpans.filter((s) => s !== root);
    groups.push({ traceId, root, children });
  }
  return groups;
}

const POLL_INTERVAL_MS = 2500;

export function TelemetryPanel({ className = "" }: { className?: string }) {
  const [spans, setSpans] = useState<RecordedSpan[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/telemetry/spans");
      const data = await res.json();
      setSpans(Array.isArray(data.spans) ? data.spans : []);
    } catch {
      // Non-fatal — keep showing whatever was last fetched.
    }
  }, []);

  useEffect(() => {
    // Initial fetch on mount, then poll — refresh()'s setState happens
    // after an internal await (fetch response), not synchronously during
    // this effect's execution, so this doesn't cause the cascading-render
    // problem the lint rule normally guards against.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  async function handleClear() {
    await fetch("/api/telemetry/spans", { method: "DELETE" });
    setSpans([]);
  }

  const groups = groupByTrace(spans);

  return (
    <Panel
      title="OpenTelemetry"
      className={`flex min-h-0 flex-col ${className}`}
      action={
        <button
          type="button"
          onClick={handleClear}
          className="text-xs font-medium text-ink-muted transition hover:text-brand"
        >
          Clear
        </button>
      }
    >
      <div className="scrollbar-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="text-xs text-ink-muted">
            Real spans for every identity call — sign in, authenticate the agent, or send a message to see them
            here. Tracked: who (identity), what happened (audit), and tokens used — not latency.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.traceId}>
              {group.root && <SpanRow span={group.root} indent={false} />}
              {group.children.map((child) => (
                <SpanRow key={child.spanId} span={child} indent />
              ))}
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
