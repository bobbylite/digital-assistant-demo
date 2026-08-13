import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { resetAgentConfiguration } from "@/lib/oidc";

/**
 * Server-only. The runtime-editable half of this app's configuration — the
 * connection defaults (region/qualifier/harness ARN) and the agent's own
 * client-credentials identity (AGENT_*). Deliberately does NOT cover
 * OIDC_* / SESSION_SECRET: those have to exist before anyone can sign in
 * at all, so there's no way to self-configure them through a UI that itself
 * requires being signed in — see the Settings section in CLAUDE.md.
 *
 * The intended deploy story: ship a container with only OIDC_* / SESSION_SECRET
 * set, sign in once, then fill in everything else here. What gets typed into
 * the Settings panel is written back into .env.local on disk (so it survives
 * a restart) AND applied to this process's live process.env immediately (so
 * it takes effect without one) — see applySettings() below for how those two
 * halves are kept from disagreeing when the write-back fails.
 */

const ENV_KEYS = {
  defaultRegion: "DEFAULT_REGION",
  defaultQualifier: "DEFAULT_QUALIFIER",
  defaultHarnessArn: "DEFAULT_HARNESS_ARN",
  agentClientId: "AGENT_CLIENT_ID",
  agentClientSecret: "AGENT_CLIENT_SECRET",
  agentScope: "AGENT_SCOPE",
  agentExchangeScope: "AGENT_EXCHANGE_SCOPE",
} as const;

type SettingsField = keyof typeof ENV_KEYS;

export interface SettingsInput {
  defaultRegion?: string;
  defaultQualifier?: string;
  defaultHarnessArn?: string;
  agentClientId?: string;
  // Omitted entirely (not just empty) means "leave unchanged" — this is
  // what lets the settings form never round-trip the current secret value
  // to the browser just to redisplay it. See getRedactedSettings().
  agentClientSecret?: string;
  agentScope?: string;
  agentExchangeScope?: string;
}

export interface RedactedSettings {
  defaultRegion: string;
  defaultQualifier: string;
  defaultHarnessArn: string;
  agentClientId: string;
  agentScope: string;
  agentExchangeScope: string;
  // Never the secret itself — just whether one is currently set, so the
  // form can render "unchanged" placeholder copy instead of a blank field
  // that looks unset when it isn't.
  hasAgentClientSecret: boolean;
}

export function getConnectionDefaults() {
  return {
    defaultRegion: process.env.DEFAULT_REGION ?? "us-east-2",
    defaultQualifier: process.env.DEFAULT_QUALIFIER ?? "DEFAULT",
    defaultHarnessArn: process.env.DEFAULT_HARNESS_ARN ?? "",
  };
}

export function getRedactedSettings(): RedactedSettings {
  return {
    ...getConnectionDefaults(),
    agentClientId: process.env.AGENT_CLIENT_ID ?? "",
    agentScope: process.env.AGENT_SCOPE ?? "agent",
    agentExchangeScope: process.env.AGENT_EXCHANGE_SCOPE ?? "agent:exchange",
    hasAgentClientSecret: Boolean(process.env.AGENT_CLIENT_SECRET),
  };
}

function envFilePath(): string {
  return path.join(process.cwd(), ".env.local");
}

// Surgical patch, not a regenerate-from-scratch: rewrites only the lines for
// keys we're changing (or appends them if the file/key doesn't exist yet),
// leaving every other line — including OIDC_*/SESSION_SECRET and any
// comments — untouched. A full round-trip parse+dump would flatten those
// comments away every time someone saves a setting.
function patchEnvFile(updates: Record<string, string>): void {
  const filePath = envFilePath();
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = existing.length > 0 ? existing.split("\n") : [];
  const remaining = new Map(Object.entries(updates));

  const patched = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    const key = match?.[1];
    if (key && remaining.has(key)) {
      const value = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });

  if (patched.length > 0 && patched[patched.length - 1] !== "") {
    patched.push("");
  }
  for (const [key, value] of remaining) {
    patched.push(`${key}=${value}`);
  }

  // 0o600: this file can hold AGENT_CLIENT_SECRET, OIDC_CLIENT_SECRET, and
  // SESSION_SECRET — owner read/write only, same as any secrets file.
  writeFileSync(filePath, patched.join("\n"), { mode: 0o600 });
}

/**
 * Applies a settings update: live immediately (process.env, so the running
 * server picks it up on the very next request — no restart needed), then
 * best-effort to disk. The two are deliberately allowed to diverge rather
 * than fail the whole request: a container running .env.local as a
 * read-only or unmounted file (see CLAUDE.md's Docker section) should still
 * let you change settings for the life of that process, just with a clear
 * warning that it won't survive a restart, instead of a hard error that
 * makes the feature unusable there.
 */
export function applySettings(input: SettingsInput): { persisted: boolean; warning?: string } {
  const updates: Partial<Record<SettingsField, string>> = {};
  for (const [field, value] of Object.entries(input) as [SettingsField, string | undefined][]) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (/[\r\n]/.test(trimmed)) {
      throw new Error(`${field} cannot contain a newline.`);
    }
    updates[field] = trimmed;
  }

  // env.d.ts marks these readonly to catch accidental writes anywhere else
  // in the app — this is the one deliberate exception, so the cast is
  // scoped narrowly to here rather than loosening the ambient type.
  const mutableEnv = process.env as Record<string, string>;
  for (const [field, value] of Object.entries(updates) as [SettingsField, string][]) {
    mutableEnv[ENV_KEYS[field]] = value;
  }

  if (updates.agentClientId !== undefined || updates.agentClientSecret !== undefined) {
    // The cached openid-client Configuration for the agent's identity has
    // the old client_id/secret baked into it — nothing short of discarding
    // it forces a re-discovery with the new credentials.
    resetAgentConfiguration();
  }

  const envUpdates: Record<string, string> = {};
  for (const [field, value] of Object.entries(updates) as [SettingsField, string][]) {
    envUpdates[ENV_KEYS[field]] = value;
  }

  try {
    patchEnvFile(envUpdates);
    return { persisted: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      persisted: false,
      warning: `Applied for this session, but couldn't save to .env.local (${detail}) — it won't survive a restart.`,
    };
  }
}
