"use client";

import { Panel } from "./Panel";
import { AgentAuthButton } from "./AgentAuthButton";

interface ConnectionPanelProps {
  jwt: string;
  onJwtChange: (v: string) => void;
  region: string;
  onRegionChange: (v: string) => void;
  harnessArn: string;
  onHarnessArnChange: (v: string) => void;
  qualifier: string;
  onQualifierChange: (v: string) => void;
  signedIn: boolean;
  agentConfigured: boolean;
  agentAuthenticated: boolean;
}

const inputClass =
  "w-full rounded-lg border border-border bg-canvas px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted/60 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20";
const labelClass = "mb-1 block text-xs font-medium uppercase tracking-wide text-ink-muted";

export function ConnectionPanel({
  jwt,
  onJwtChange,
  region,
  onRegionChange,
  harnessArn,
  onHarnessArnChange,
  qualifier,
  onQualifierChange,
  signedIn,
  agentConfigured,
  agentAuthenticated,
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
      </div>
    </Panel>
  );
}
