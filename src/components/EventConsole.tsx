"use client";

import { useEffect, useRef } from "react";
import { Panel } from "./Panel";

export interface StreamEvent {
  id: string;
  ts: number;
  type: string;
  payload: unknown;
}

const TYPE_COLOR: Record<string, string> = {
  messageStart: "text-brand",
  contentBlockDelta: "text-ink",
  contentBlockStop: "text-ink-muted",
  messageStop: "text-success",
  metadata: "text-brand",
  "agent-error": "text-danger",
  "stream-error": "text-danger",
  done: "text-ink-muted",
};

const ERROR_TYPES = new Set(["agent-error", "stream-error"]);

export function EventConsole({
  events,
  onClear,
  className = "",
}: {
  events: StreamEvent[];
  onClear: () => void;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <Panel
      title="Raw event stream"
      className={`flex min-h-0 flex-col ${className}`}
      action={
        <button
          type="button"
          onClick={onClear}
          className="text-xs font-medium text-ink-muted transition hover:text-brand"
        >
          Clear
        </button>
      }
    >
      <div
        ref={scrollRef}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-canvas p-3 font-mono text-xs leading-relaxed"
      >
        {events.length === 0 ? (
          <p className="text-ink-muted">Events will appear here as they stream in.</p>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className={`mb-1.5 border-l-2 py-0.5 pl-2 ${
                ERROR_TYPES.has(event.type) ? "border-danger bg-danger/5" : "border-brand/40"
              }`}
            >
              <span className="text-ink-muted">{new Date(event.ts).toLocaleTimeString()} </span>
              <span className={`font-semibold ${TYPE_COLOR[event.type] || "text-ink"}`}>{event.type}</span>
              <pre className="whitespace-pre-wrap break-all text-ink-muted">{JSON.stringify(event.payload)}</pre>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
