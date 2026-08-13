export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: Array<{ text: string }>;
}

export interface InvokeRequestBody {
  jwt: string;
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
