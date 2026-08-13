"use client";

import { Panel } from "./Panel";

export function SessionPanel({
  sessionId,
  onNewSession,
}: {
  sessionId: string;
  onNewSession: () => void;
}) {
  return (
    <Panel title="Session">
      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink-muted" htmlFor="sessionId">
        Session ID
      </label>
      <div className="flex gap-2">
        <input
          id="sessionId"
          readOnly
          value={sessionId}
          className="w-full rounded-lg border border-border bg-canvas px-3 py-2 font-mono text-xs text-ink-muted"
        />
        <button
          type="button"
          onClick={onNewSession}
          className="shrink-0 rounded-lg border border-border px-3 py-2 text-xs font-medium text-ink transition hover:border-brand hover:text-brand"
        >
          New
        </button>
      </div>
    </Panel>
  );
}
