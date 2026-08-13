"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { TopBar, type Status } from "./TopBar";
import { ChatPanel } from "./ChatPanel";
import { ConnectionPanel } from "./ConnectionPanel";
import { SessionPanel } from "./SessionPanel";
import { MetricsPanel } from "./MetricsPanel";
import { EventConsole, type StreamEvent } from "./EventConsole";
import { generateSessionId } from "@/lib/session";
import { DEFAULT_REGION, DEFAULT_QUALIFIER, DEFAULT_HARNESS_ARN } from "@/lib/env";
import type { ChatMessage, ResponseMetrics } from "@/lib/types";

const STORAGE_KEY = "agentcore-console-connection";

export function AgentConsole() {
  const [jwt, setJwt] = useState("");
  const [region, setRegion] = useState(DEFAULT_REGION);
  const [harnessArn, setHarnessArn] = useState(DEFAULT_HARNESS_ARN);
  const [qualifier, setQualifier] = useState(DEFAULT_QUALIFIER);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [metrics, setMetrics] = useState<ResponseMetrics>({});
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const assistantIndexRef = useRef<number | null>(null);

  useEffect(() => {
    // Generated client-side only: a random UUID here would mismatch between
    // the server-rendered HTML and the client's first render (hydration error).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessionId(generateSessionId());
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.jwt) setJwt(parsed.jwt);
        if (parsed.region) setRegion(parsed.region);
        if (parsed.harnessArn) setHarnessArn(parsed.harnessArn);
        if (parsed.qualifier) setQualifier(parsed.qualifier);
      }
    } catch {
      // ignore malformed/unavailable storage
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
    setMetrics({});
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
    } else if (type === "metadata") {
      const meta = payload as { metrics?: { latencyMs?: number }; usage?: ResponseMetrics };
      setMetrics({
        latencyMs: meta.metrics?.latencyMs,
        inputTokens: meta.usage?.inputTokens,
        outputTokens: meta.usage?.outputTokens,
        totalTokens: meta.usage?.totalTokens,
      });
    } else if (type === "agent-error" || type === "stream-error") {
      const msg = (payload as { message?: string })?.message || "The agent runtime returned an error.";
      setError(msg);
      setStatus("error");
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || status === "connecting" || status === "streaming") return;

    if (!jwt.trim() || !harnessArn.trim() || !region.trim()) {
      setError("JWT, region, and harness ARN are all required.");
      return;
    }

    setError(null);
    const userMessage: ChatMessage = { role: "user", content: [{ text: trimmed }] };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
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
      return;
    }

    if (!response.ok || !response.body) {
      const errBody = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      setError(errBody.error || `HTTP ${response.status}`);
      setStatus("error");
      return;
    }

    setStatus("streaming");
    assistantIndexRef.current = nextMessages.length;
    setMessages((prev) => [...prev, { role: "assistant", content: [{ text: "" }] }]);

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
      return;
    }

    setStatus((prev) => (prev === "error" ? prev : "connected"));
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar status={status} />
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
          />
          <SessionPanel sessionId={sessionId} onNewSession={handleNewSession} />
          <MetricsPanel metrics={metrics} />
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
