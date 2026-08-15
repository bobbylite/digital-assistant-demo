"use client";

import { Panel } from "./Panel";
import { AgentAuthButton } from "./AgentAuthButton";
import type { RuntimeMode } from "@/lib/types";

interface ConnectionPanelProps {
  jwt: string;
  onJwtChange: (v: string) => void;
  region: string;
  onRegionChange: (v: string) => void;
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (v: RuntimeMode) => void;
  harnessArn: string;
  onHarnessArnChange: (v: string) => void;
  agentRuntimeArn: string;
  onAgentRuntimeArnChange: (v: string) => void;
  localAgentUrl: string;
  onLocalAgentUrlChange: (v: string) => void;
  qualifier: string;
  onQualifierChange: (v: string) => void;
  signedIn: boolean;
  agentConfigured: boolean;
  agentAuthenticated: boolean;
  sessionId: string;
  onNewSession: () => void;
}

const inputClass =
  "w-full rounded-lg border border-border bg-canvas px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted/60 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20";
const labelClass = "mb-1 block text-xs font-medium uppercase tracking-wide text-ink-muted";

const RUNTIME_MODE_OPTIONS: Array<{ value: RuntimeMode; label: string }> = [
  { value: "harness", label: "Harness (AWS-managed)" },
  { value: "agentRuntime", label: "Agent Runtime (AWS, custom agent)" },
  { value: "local", label: "Local Agent (this repo's agent/)" },
];

export function ConnectionPanel({
  jwt,
  onJwtChange,
  region,
  onRegionChange,
  runtimeMode,
  onRuntimeModeChange,
  harnessArn,
  onHarnessArnChange,
  agentRuntimeArn,
  onAgentRuntimeArnChange,
  localAgentUrl,
  onLocalAgentUrlChange,
  qualifier,
  onQualifierChange,
  signedIn,
  agentConfigured,
  agentAuthenticated,
  sessionId,
  onNewSession,
}: ConnectionPanelProps) {
  return (
    <Panel title="Connection">
      <div className="space-y-3">
        <div>
          <label className={labelClass} htmlFor="jwt">
            Bearer JWT
          </label>
          {signedIn ? (
            <p className="rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-xs text-ink-muted">
              Using your signed-in session — this field is ignored while signed in.
            </p>
          ) : (
            <textarea
              id="jwt"
              value={jwt}
              onChange={(e) => onJwtChange(e.target.value)}
              placeholder="eyJhbGciOi..."
              rows={2}
              className={`${inputClass} resize-none font-mono text-xs`}
            />
          )}
          <AgentAuthButton configured={agentConfigured} initiallyAuthenticated={agentAuthenticated} />
        </div>
        <div>
          <label className={labelClass} htmlFor="runtimeMode">
            Runtime target
          </label>
          <select
            id="runtimeMode"
            value={runtimeMode}
            onChange={(e) => onRuntimeModeChange(e.target.value as RuntimeMode)}
            className={inputClass}
          >
            {RUNTIME_MODE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        {runtimeMode !== "local" && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass} htmlFor="region">
                Region
              </label>
              <input
                id="region"
                value={region}
                onChange={(e) => onRegionChange(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="qualifier">
                Qualifier
              </label>
              <input
                id="qualifier"
                value={qualifier}
                onChange={(e) => onQualifierChange(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>
        )}
        {runtimeMode === "harness" && (
          <div>
            <label className={labelClass} htmlFor="harnessArn">
              Harness ARN
            </label>
            <input
              id="harnessArn"
              value={harnessArn}
              onChange={(e) => onHarnessArnChange(e.target.value)}
              placeholder="arn:aws:bedrock-agentcore:..."
              className={`${inputClass} font-mono text-xs`}
            />
          </div>
        )}
        {runtimeMode === "agentRuntime" && (
          <div>
            <label className={labelClass} htmlFor="agentRuntimeArn">
              Agent Runtime ARN
            </label>
            <input
              id="agentRuntimeArn"
              value={agentRuntimeArn}
              onChange={(e) => onAgentRuntimeArnChange(e.target.value)}
              placeholder="arn:aws:bedrock-agentcore:..."
              className={`${inputClass} font-mono text-xs`}
            />
          </div>
        )}
        {runtimeMode === "local" && (
          <div>
            <label className={labelClass} htmlFor="localAgentUrl">
              Local Agent URL
            </label>
            <input
              id="localAgentUrl"
              value={localAgentUrl}
              onChange={(e) => onLocalAgentUrlChange(e.target.value)}
              placeholder="http://localhost:8080"
              className={`${inputClass} font-mono text-xs`}
            />
          </div>
        )}
        <div>
          <label className={labelClass} htmlFor="sessionId">
            Session ID
          </label>
          <div className="flex gap-2">
            <input
              id="sessionId"
              readOnly
              value={sessionId}
              className={`${inputClass} font-mono text-xs text-ink-muted`}
            />
            <button
              type="button"
              onClick={onNewSession}
              className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink transition hover:border-brand hover:text-brand"
            >
              New
            </button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
