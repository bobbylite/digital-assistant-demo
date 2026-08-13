"use client";

import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import type { ChatMessage } from "@/lib/types";
import type { Status } from "./TopBar";
import { MarkdownMessage } from "./MarkdownMessage";

interface ChatPanelProps {
  messages: ChatMessage[];
  prompt: string;
  onPromptChange: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  status: Status;
  error: string | null;
}

export function ChatPanel({ messages, prompt, onPromptChange, onSubmit, status, error }: ChatPanelProps) {
  const busy = status === "connecting" || status === "streaming";
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-surface shadow-sm">
      <div className="shrink-0 border-b border-border px-6 py-4">
        <h1 className="text-xl font-medium tracking-tight text-ink">Harness Streaming Console</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Send a message to your Bedrock AgentCore harness and watch the response stream in token by token.
        </p>
      </div>

      <div ref={scrollRef} className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-6">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-sm text-ink-muted">
            <p className="max-w-xs">
              No messages yet. Configure your connection on the right, then send a prompt to begin.
            </p>
          </div>
        ) : (
          messages.map((message, i) => (
            <div key={i} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-lg px-4 py-3 text-sm leading-relaxed ${
                  message.role === "user"
                    ? "rounded-br-sm bg-brand whitespace-pre-wrap text-white"
                    : "rounded-bl-sm border border-border bg-canvas text-ink"
                }`}
              >
                {message.content[0]?.text ? (
                  message.role === "assistant" ? (
                    <MarkdownMessage text={message.content[0].text} />
                  ) : (
                    message.content[0].text
                  )
                ) : (
                  <span className="inline-flex gap-1 py-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-muted [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-muted [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-muted" />
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {error && (
        <div className="mx-6 mb-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-2.5 text-sm text-danger">
          {error}
        </div>
      )}

      <form onSubmit={onSubmit} className="border-t border-border px-6 py-4">
        <div className="flex items-end gap-3">
          <textarea
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask your agent something…"
            rows={2}
            required
            className="flex-1 resize-none rounded-md border border-border bg-canvas px-4 py-3 text-sm text-ink placeholder:text-ink-muted/70 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
          />
          <button
            type="submit"
            disabled={busy || !prompt.trim()}
            className="flex h-11 items-center gap-2 bg-brand px-5 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Streaming…" : "Send"}
            {!busy && (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2 8h11M9 4l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-muted">Enter to send · Shift+Enter for a new line</p>
      </form>
    </section>
  );
}
