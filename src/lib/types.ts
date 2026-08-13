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

export interface ResponseMetrics {
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AuthSession {
  oidcEnabled: boolean;
  authenticated: boolean;
  sub?: string;
  name?: string;
  email?: string;
}
