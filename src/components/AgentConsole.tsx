"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { TopBar, type Status } from "./TopBar";
import { ChatPanel } from "./ChatPanel";
import { ConnectionPanel } from "./ConnectionPanel";
import { TelemetryPanel } from "./TelemetryPanel";
import { EventConsole, type StreamEvent } from "./EventConsole";
import { generateSessionId } from "@/lib/session";
import type { AuthSession, ChatMessage } from "@/lib/types";

const STORAGE_KEY = "agentcore-console-connection";

const AUTH_ERROR_COPY: Record<string, string> = {
  not_configured: "OIDC is not configured on this server.",
  expired_login: "Sign-in expired or was already used — try signing in again.",
  discovery_failed: "Couldn't reach the identity provider's discovery endpoint.",
  incomplete_response: "The identity provider's response was missing required fields.",
  exchange_failed: "Token exchange with the identity provider failed.",
};

export function AgentConsole() {
  const [jwt, setJwt] = useState("");
  const [region, setRegion] = useState("");
  const [harnessArn, setHarnessArn] = useState("");
  const [qualifier, setQualifier] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);

  const assistantIndexRef = useRef<number | null>(null);

  async function refreshAuthSession() {
    try {
      const res = await fetch("/api/auth/session");
      const data: AuthSession = await res.json();
      setAuthSession(data);
    } catch {
      // Non-fatal — falls back to manual JWT paste mode.
      setAuthSession({ oidcEnabled: false, authenticated: false, agentConfigured: false, agentAuthenticated: false });
    }
  }

  useEffect(() => {
    // Generated client-side only: a random UUID here would mismatch between
    // the server-rendered HTML and the client's first render (hydration error).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessionId(generateSessionId());

    let restoredRegion = false;
    let restoredQualifier = false;
    let restoredHarnessArn = false;
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.jwt) setJwt(parsed.jwt);
        if (parsed.region) {
          setRegion(parsed.region);
          restoredRegion = true;
        }
        if (parsed.harnessArn) {
          setHarnessArn(parsed.harnessArn);
          restoredHarnessArn = true;
        }
        if (parsed.qualifier) {
          setQualifier(parsed.qualifier);
          restoredQualifier = true;
        }
      }
    } catch {
      // ignore malformed/unavailable storage
    }

    // Server-side connection defaults — previously NEXT_PUBLIC_*-inlined
    // constants, now fetched at runtime so the Settings panel can change
    // them without a rebuild. Only fills in whatever sessionStorage didn't
    // already restore, so a slower fetch never clobbers an in-progress edit.
    fetch("/api/config")
      .then((res) => res.json())
      .then((data: { defaultRegion?: string; defaultQualifier?: string; defaultHarnessArn?: string }) => {
        if (!restoredRegion && data.defaultRegion) setRegion(data.defaultRegion);
        if (!restoredQualifier && data.defaultQualifier) setQualifier(data.defaultQualifier);
        if (!restoredHarnessArn && data.defaultHarnessArn) setHarnessArn(data.defaultHarnessArn);
      })
      .catch(() => {
        // Non-fatal — fields just stay empty until typed in by hand.
      });

    refreshAuthSession();

    // Surface a redirect-back error from /api/auth/callback, then scrub it
    // from the URL so a reload doesn't re-show it.
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    if (authError) {
      const detail = params.get("auth_error_detail");
      const summary = AUTH_ERROR_COPY[authError] ?? "Sign-in failed.";
      setError(detail ? `${summary} (${detail})` : summary);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ jwt, region, harnessArn, qualifier }));
    } catch {
      // sessionStorage unavailable (e.g. private mode) — non-fatal
    }
  }, [jwt, region, harnessArn, qualifier]);

  function logEvent(type: string, payload: unknown) {
    setEvents((prev) => {
      const next = [...prev, { id: `${Date.now()}-${prev.length}`, ts: Date.now(), type, payload }];
      return next.length > 300 ? next.slice(next.length - 300) : next;
    });
  }

  function handleNewSession() {
    setSessionId(generateSessionId());
    setMessages([]);
    setEvents([]);
    setError(null);
    setStatus("idle");
  }

  function applyDelta(index: number, text: string) {
    setMessages((prev) => {
      const next = [...prev];
      const existing = next[index];
      if (!existing) return prev;
      next[index] = { ...existing, content: [{ text: existing.content[0].text + text }] };
      return next;
    });
  }

  function handleSSEBlock(block: string) {
    const lines = block.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event: "));
    const dataLine = lines.find((l) => l.startsWith("data: "));
    if (!eventLine || !dataLine) return;

    const type = eventLine.slice("event: ".length);
    let payload: unknown = {};
    try {
      payload = JSON.parse(dataLine.slice("data: ".length));
    } catch {
      payload = {};
    }

    logEvent(type, payload);

    if (type === "contentBlockDelta") {
      const text = (payload as { delta?: { text?: string } })?.delta?.text;
      if (text && assistantIndexRef.current !== null) {
        applyDelta(assistantIndexRef.current, text);
      }
      // "metadata" (token usage) is still logged above via logEvent — it's
      // just not tracked in separate client state anymore. The server-side
      // span for this call already recorded it (token.input/output/total on
      // the agentcore.invoke span); see the OpenTelemetry panel.
    } else if (type === "agent-error" || type === "stream-error") {
      const msg = (payload as { message?: string })?.message || "The agent runtime returned an error.";
      setError(msg);
      setStatus("error");
      dropEmptyAssistantPlaceholder();
    }
  }

  // Removes the trailing assistant placeholder added at the start of
  // handleSend if it never received any text — otherwise an error before
  // the first token would leave a permanently-"thinking" bubble sitting in
  // the transcript next to the error banner. Leaves it alone (keeps
  // whatever partial text streamed in) once there's real content.
  function dropEmptyAssistantPlaceholder() {
    const idx = assistantIndexRef.current;
    if (idx === null) return;
    setMessages((prev) => {
      const msg = prev[idx];
      return msg && msg.role === "assistant" && !msg.content[0].text ? prev.slice(0, idx) : prev;
    });
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || status === "connecting" || status === "streaming") return;

    const signedIn = authSession?.authenticated ?? false;
    if ((!signedIn && !jwt.trim()) || !harnessArn.trim() || !region.trim()) {
      setError(
        signedIn
          ? "Region and harness ARN are required."
          : "Sign in, or paste a JWT, plus region and harness ARN, are required."
      );
      return;
    }

    setError(null);
    const userMessage: ChatMessage = { role: "user", content: [{ text: trimmed }] };
    const nextMessages = [...messages, userMessage];
    // The assistant placeholder (rendered as a "thinking" bouncing-dots
    // bubble by ChatPanel whenever content is empty — see MessageBubble
    // there) goes in immediately, not once the response starts streaming
    // back. Otherwise the chat window shows nothing at all during the
    // fetch/connect round trip, which is exactly the gap that looks broken.
    assistantIndexRef.current = nextMessages.length;
    setMessages([...nextMessages, { role: "assistant", content: [{ text: "" }] }]);
    setPrompt("");
    setStatus("connecting");

    let response: globalThis.Response;
    try {
      response = await fetch("/api/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jwt, region, harnessArn, qualifier, sessionId, messages: nextMessages }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error reaching the local proxy.");
      setStatus("error");
      dropEmptyAssistantPlaceholder();
      return;
    }

    if (!response.ok || !response.body) {
      const errBody = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      setError(errBody.error || `HTTP ${response.status}`);
      setStatus("error");
      dropEmptyAssistantPlaceholder();
      return;
    }

    setStatus("streaming");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          handleSSEBlock(rawEvent);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stream interrupted.");
      setStatus("error");
      dropEmptyAssistantPlaceholder();
      return;
    }

    setStatus((prev) => (prev === "error" ? prev : "connected"));
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar status={status} authSession={authSession} onSettingsSaved={refreshAuthSession} />
      <main className="mx-auto flex w-full min-h-0 max-w-7xl flex-1 flex-col gap-4 overflow-hidden px-6 py-4 lg:flex-row">
        <ChatPanel
          messages={messages}
          prompt={prompt}
          onPromptChange={setPrompt}
          onSubmit={handleSend}
          status={status}
          error={error}
        />
        <aside className="scrollbar-thin flex w-full min-h-0 flex-col gap-3 overflow-y-auto lg:w-[360px] lg:shrink-0">
          <ConnectionPanel
            jwt={jwt}
            onJwtChange={setJwt}
            region={region}
            onRegionChange={setRegion}
            harnessArn={harnessArn}
            onHarnessArnChange={setHarnessArn}
            qualifier={qualifier}
            onQualifierChange={setQualifier}
            signedIn={authSession?.authenticated ?? false}
            agentConfigured={authSession?.agentConfigured ?? false}
            agentAuthenticated={authSession?.agentAuthenticated ?? false}
            sessionId={sessionId}
            onNewSession={handleNewSession}
          />
          <TelemetryPanel className="min-h-[160px] flex-1" />
          <EventConsole events={events} onClear={() => setEvents([])} className="min-h-[130px] flex-1" />
        </aside>
      </main>
      <footer className="shrink-0 border-t border-border bg-surface px-6 py-2.5 text-center text-xs text-ink-muted">
        Runs locally. Your JWT stays in this browser tab and is sent only to this local server, which proxies the
        call to <span className="font-mono">bedrock-agentcore.{region || "{region}"}.amazonaws.com</span>.
      </footer>
    </div>
  );
}
