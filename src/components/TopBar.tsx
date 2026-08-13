import { ThemeToggle } from "./ThemeToggle";
import { AuthControl } from "./AuthControl";
import { SettingsButton } from "./SettingsButton";
import type { AuthSession } from "@/lib/types";

export type Status = "idle" | "connecting" | "streaming" | "connected" | "error";

const STATUS_COPY: Record<Status, string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  streaming: "Streaming",
  connected: "Connected",
  error: "Error",
};

const STATUS_COLOR: Record<Status, string> = {
  idle: "bg-ink-muted",
  connecting: "bg-brand animate-pulse",
  streaming: "bg-success animate-pulse",
  connected: "bg-success",
  error: "bg-danger",
};

interface TopBarProps {
  status: Status;
  authSession: AuthSession | null;
  onSettingsSaved: () => void;
}

export function TopBar({ status, authSession, onSettingsSaved }: TopBarProps) {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center text-brand">
            <svg viewBox="0 0 40 40" width="26" height="26">
              <circle cx="20" cy="20" r="4" fill="currentColor" />
              <circle cx="20" cy="20" r="12" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.55" />
              <circle cx="20" cy="20" r="19" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
            </svg>
          </span>
          <span className="text-lg font-semibold tracking-tight text-ink">
            AgentCore<span className="text-brand">Console</span>
          </span>
        </div>
        <div className="flex items-center gap-4">
          <AuthControl session={authSession} />
          {authSession?.authenticated && <SettingsButton onSaved={onSettingsSaved} />}
          <div className="flex items-center gap-2 text-sm text-ink-muted">
            <span className={`h-2 w-2 rounded-full ${STATUS_COLOR[status]}`} />
            {STATUS_COPY[status]}
          </div>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
