# AgentCore Console

![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Tailwind CSS v4](https://img.shields.io/badge/Tailwind-v4-38BDF8?logo=tailwindcss&logoColor=white)
![Secret scanning](https://img.shields.io/badge/secrets-gitleaks%20on%20every%20push-critical)

A local, security-minded console for streaming chat with an **Amazon Bedrock
AgentCore harness** over its JWT-authenticated HTTPS endpoint — the kind of
tool you reach for when you need to actually see what your agent is doing at
the protocol level, not just whether it "worked."

No AWS SDK, no SigV4, no server-side session. You bring a bearer token, this
proxies the raw HTTPS call, decodes AWS's binary event-stream framing in
real time, and renders the response as it streams in — markdown and all —
next to a live feed of the exact events AgentCore sent back.

## Why a proxy, and why does that matter for security

Browsers can't call `bedrock-agentcore.*.amazonaws.com` directly — CORS
blocks it, and the response body isn't JSON or plain SSE, it's AWS's
`application/vnd.amazon.eventstream` binary framing (4-byte length prefixes,
CRC trailers, the works). So this app is a small Next.js server that makes
the real HTTPS call on your behalf and decodes that framing before it ever
reaches the browser.

That server is intentionally dumb: it does not log the request, does not
persist the token anywhere (memory, disk, or otherwise), and forwards
exactly one header — `Authorization: Bearer <your JWT>` — straight through
to AWS. Nothing about your identity gets stored server-side. See
`src/app/api/invoke/route.ts` if you want to verify that yourself; it's
~130 lines.

## AgentCore's identity model is stricter than "any valid JWT"

This is the part worth actually understanding before you go looking for a
token to paste in, because it trips people up: AgentCore does not accept an
arbitrary signed JWT just because it's valid. A harness or runtime
configured for JWT inbound auth validates it against a `customJWTAuthorizer`
you defined when you created it — the token's `iss` must match your
discovery URL, and its `client_id` / `aud` must appear in the authorizer's
`allowedClients` / `allowedAudience`. IAM (SigV4) and JWT auth are also
mutually exclusive per runtime — you don't get to fall back to one when the
other is inconvenient.

In practice, that `client_id` constraint is the sharp edge. If your users
already authenticate against your own web app's OAuth client — which is the
normal case — the token your IdP hands them carries *your app's* client ID,
not the agent's. AgentCore will reject it outright, correctly, because
nothing about that token proves it was ever meant to reach this agent.

**Getting a token that satisfies both constraints — the real user as
`sub`, and the agent's own registered `client_id` as audience — is what
[RFC 8693 (OAuth 2.0 Token Exchange)](https://www.rfc-editor.org/rfc/rfc8693)
is for.** Concretely: your IdP's token endpoint takes the user's existing
token as `subject_token` and mints a new one for the agent's client,
`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, subject
preserved. Most enterprise IdPs (Okta, Auth0, PingFederate/PingOne, Curity,
and others) support this natively as a token-endpoint grant type — it's not
an AgentCore-specific mechanism, it's the standard OAuth answer to "same
user, different audience." *That* exchanged token is what belongs in this
console's JWT field.

Worth being precise about scope: AWS also bakes RFC 8693 (and RFC 7523)
directly into AgentCore Identity itself — but for a different, later step in
the pipeline. Once your agent is already running, [AgentCore's on-behalf-of
token exchange](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/on-behalf-of-token-exchange.html)
lets it exchange *your* inbound token again, transparently, to call
downstream tools and resource servers without a second consent prompt. That
one AWS handles for you inside the harness; the inbound exchange described
above is on you, against your own IdP, before the token ever reaches this
console.

## Secret scanning

Every push and pull request runs [Gitleaks](https://github.com/gitleaks/gitleaks)
against the full commit history (`.github/workflows/secret-scan.yml`) — via
its open-source CLI directly through the official Docker image, not the
`gitleaks-action` wrapper, which requires a paid license for org-owned repos
and is set to stop working once GitHub retires Node 20 runners. The
underlying scanner is free regardless of account type; this setup doesn't
depend on either of those.

Locally, the same check `.env*` gitignore rule that keeps `.env.local` (your
real region/harness ARN) out of git also means there's nothing
account-specific for the scanner — or a reviewer — to trip over. The JWT
itself was never a candidate for a file in the first place; see above.

## Quick start

```bash
npm install
cp .env.local.example .env.local   # fill in your region / harness ARN — optional, just pre-fills the UI
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), paste your (correctly
exchanged) JWT into the Connection panel along with your harness ARN, and
send a message. Toggle dark mode from the top bar; it persists across
reloads.

## How it works

1. **`src/app/api/invoke/route.ts`** — receives `{ jwt, region, harnessArn,
   qualifier, sessionId, messages }` from the browser, calls AgentCore's
   `InvokeHarness` endpoint with your bearer token, and decodes the
   streamed event-stream binary frames (`@smithy/eventstream-codec`) as
   they arrive — buffering only enough bytes to complete one frame at a
   time, never the whole response.
2. Each decoded frame is re-emitted to the browser as a hand-rolled
   server-sent event over the same connection (plain `EventSource` can't
   POST or set custom headers, so both ends parse SSE manually — see
   `AgentConsole.tsx`).
3. The client renders `contentBlockDelta` text as it streams, through
   `react-markdown` + `remark-gfm`, while every raw event — `messageStart`,
   `contentBlockDelta`, `metadata`, errors, all of it — shows up live in the
   "Raw event stream" panel so you can see exactly what AgentCore sent, not
   just the rendered result.

Full architecture notes, AgentCore API gotchas (harness-vs-runtime ARNs,
the `:event-type` header colon-prefix that silently breaks naive parsing,
session-ID validation quirks), and conventions live in `CLAUDE.md` — read
that before making structural changes.

## Environment variables

Next.js has no separate config-file convention — it reads `.env.local` via
`process.env`, and only `NEXT_PUBLIC_*`-prefixed vars reach the browser
bundle (this app's connection panel is client-side, so that's what's used
here). See `.env.local.example` for the full list; none of them are secret,
and the JWT is never one of them — it's typed into the UI at runtime, every
time, and lives only in that browser tab.

## Development

```bash
npm run dev       # Turbopack dev server, :3000
npm run build     # production build
npm run lint      # ESLint
npx tsc --noEmit  # typecheck
```

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS v4 · React 19 ·
`react-markdown` + `remark-gfm` · `@smithy/eventstream-codec` for the AWS
binary framing.
