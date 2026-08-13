/**
 * Client-visible connection defaults, pre-filled into the Connection panel
 * on first load. All are `NEXT_PUBLIC_*` since they're read from a client
 * component (AgentConsole) — Next.js only inlines env vars into the browser
 * bundle when they carry that prefix; anything else stays server-only.
 *
 * None of these are secret. The JWT itself is never read from env — it's
 * always typed/pasted into the UI at runtime.
 */
export const DEFAULT_REGION = process.env.NEXT_PUBLIC_DEFAULT_REGION ?? "us-east-2";
export const DEFAULT_QUALIFIER = process.env.NEXT_PUBLIC_DEFAULT_QUALIFIER ?? "DEFAULT";
export const DEFAULT_HARNESS_ARN = process.env.NEXT_PUBLIC_DEFAULT_HARNESS_ARN ?? "";
