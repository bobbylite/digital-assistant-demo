export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: Array<{ text: string }>;
}

export interface InvokeRequestBody {
  // Optional: omitted when the browser has a signed-in OIDC session — the
  // route handler uses the session cookie's access token instead. Required
  // when there's no session (manual-paste mode).
  jwt?: string;
  region: string;
  harnessArn: string;
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
