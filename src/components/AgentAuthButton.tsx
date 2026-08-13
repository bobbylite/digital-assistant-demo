"use client";

import { useState } from "react";

type AgentAuthState = "idle" | "loading" | "success" | "error";

interface AgentAuthButtonProps {
  configured: boolean;
  initiallyAuthenticated: boolean;
}

export function AgentAuthButton({ configured, initiallyAuthenticated }: AgentAuthButtonProps) {
  const [state, setState] = useState<AgentAuthState>(initiallyAuthenticated ? "success" : "idle");
  // Bumped on every successful (re-)auth so the ping-ring spans remount and
  // the animation replays — React won't re-run a CSS animation on a DOM
  // node whose props didn't structurally change otherwise.
  const [burstKey, setBurstKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  if (!configured) return null;

  async function handleClick() {
    setState("loading");
    setError(null);
    try {
      const res = await fetch("/api/auth/agent-token", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setState("success");
      setBurstKey((k) => k + 1);
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Agent authentication failed.");
    }
  }

  const isSuccess = state === "success";
  const isLoading = state === "loading";

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={handleClick}
        disabled={isLoading}
        title={isSuccess ? "Click to re-authenticate" : undefined}
        className={`relative flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
          isSuccess
            ? "border-success/40 bg-success/10 text-success hover:border-success"
            : "border-border text-ink hover:border-brand hover:text-brand"
        }`}
      >
        {isSuccess && (
          <span key={burstKey} aria-hidden className="pointer-events-none absolute inset-0">
            <span className="absolute inset-0 rounded-lg border-2 border-success animate-agent-ping-ring" />
            <span
              className="absolute inset-0 rounded-lg border-2 border-success animate-agent-ping-ring"
              style={{ animationDelay: "160ms" }}
            />
          </span>
        )}

        {isLoading ? (
          <>
            <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-90" fill="currentColor" d="M22 12a10 10 0 0 0-10-10v3a7 7 0 0 1 7 7h3Z" />
            </svg>
            Authenticating…
          </>
        ) : isSuccess ? (
          <span key={burstKey} className="flex items-center gap-1.5 animate-agent-check-pop">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Agent Authenticated
          </span>
        ) : (
          "Authenticate Agent"
        )}
      </button>
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}
