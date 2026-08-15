export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: Array<{ text: string }>;
}

// Which AgentCore invocation target this request is for — the AWS-managed
// harness (InvokeHarness), a deployed custom AgentCore Runtime
// (InvokeAgentRuntime), or the custom agent running locally (see agent/ at
// the repo root). Defaults to "harness" when omitted, for backward
// compatibility with any caller not yet sending it.
export type RuntimeMode = "harness" | "agentRuntime" | "local";

export interface InvokeRequestBody {
  // Optional: omitted when the browser has a signed-in OIDC session — the
  // route handler uses the session cookie's access token instead. Required
  // when there's no session (manual-paste mode).
  jwt?: string;
  // Required for "harness"/"agentRuntime" (part of the invocation URL);
  // unused for "local".
  region?: string;
  runtimeMode?: RuntimeMode;
  // Exactly one of these three is required, depending on runtimeMode.
  harnessArn?: string;
  agentRuntimeArn?: string;
  localAgentUrl?: string;
  qualifier?: string;
  sessionId: string;
  messages: ChatMessage[];
}

export interface AuthSession {
  oidcEnabled: boolean;
  authenticated: boolean;
  sub?: string;
  name?: string;
  email?: string;
  agentConfigured: boolean;
  agentAuthenticated: boolean;
}

// A redacted view of a real OpenTelemetry span — see src/lib/telemetry.ts
// for how these get created and why nothing token-shaped can end up in
// `attributes`. Shared here (not defined in telemetry.ts) because this
// shape needs to be safe to import from client components.
export interface RecordedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeMs: number;
  status: "OK" | "ERROR" | "UNSET";
  statusMessage?: string;
  attributes: Record<string, string | number | boolean>;
}
