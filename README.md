# AgentCore Console

![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=next.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Tailwind CSS v4](https://img.shields.io/badge/Tailwind-v4-38BDF8?logo=tailwindcss&logoColor=white)
![Secret scanning](https://img.shields.io/badge/secrets-gitleaks%20on%20every%20push-critical)

A local, security-minded console for streaming chat with an **Amazon Bedrock
AgentCore harness** over its JWT-authenticated HTTPS endpoint — the kind of
tool you reach for when you need to actually see what your agent is doing at
the protocol level, not just whether it "worked."

No AWS SDK, no SigV4. Two ways to authenticate: sign in through a real OIDC
login (Authorization Code + PKCE against a PingOne tenant — nothing but an
encrypted cookie ever reaches your browser), or paste a bearer token
directly for quick testing. Either way, this proxies the raw HTTPS call,
decodes AWS's binary event-stream framing in real time, and renders the
response as it streams in — markdown and all — next to a live feed of the
exact events AgentCore sent back.

## Why a proxy, and why does that matter for security

Browsers can't call `bedrock-agentcore.*.amazonaws.com` directly — CORS
blocks it, and the response body isn't JSON or plain SSE, it's AWS's
`application/vnd.amazon.eventstream` binary framing (4-byte length prefixes,
CRC trailers, the works). So this app is a small Next.js server that makes
the real HTTPS call on your behalf and decodes that framing before it ever
reaches the browser.

That server doesn't log the request or the token. What it persists depends
on how you signed in:

- **Pasted a JWT?** Nothing server-side, ever — it's forwarded per-request
  and lives only in your browser tab (React state + `sessionStorage`).
- **Signed in via OIDC?** The access token exists encrypted, inside an
  `HttpOnly` cookie your JavaScript can't read — see below. It's decrypted
  server-side for exactly as long as one request to AgentCore takes, and
  nowhere else.

Either way, exactly one header reaches AWS: `Authorization: Bearer <token>`.
See `src/app/api/invoke/route.ts` if you want to verify that yourself; it's
~150 lines.

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
console's JWT field, if you're pasting one in manually.

There's a simpler way to end up in the same place, and it's what this
console's OIDC sign-in does: register *this app itself* as the OAuth client
whose `client_id` is in the harness's `allowedClients`, and skip the
exchange entirely. A normal Authorization Code login against that client
already produces a token with the real user as `sub` and the right
`client_id` as audience, by construction — there's no second audience to
exchange into because the app that requested the token *is* the agent's
client. This only works if your users are meant to authenticate directly
against this console (or whatever replaces it in production); if they
instead log into some other, central portal first, that portal's token
still needs the RFC 8693 exchange described above before it'll satisfy this
agent. Different shape of the same underlying constraint.

Worth being precise about scope: AWS also bakes RFC 8693 (and RFC 7523)
directly into AgentCore Identity itself — but for a different, later step in
the pipeline. Once your agent is already running, [AgentCore's on-behalf-of
token exchange](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/on-behalf-of-token-exchange.html)
lets it exchange *your* inbound token again, transparently, to call
downstream tools and resource servers without a second consent prompt. That
one AWS handles for you inside the harness; the inbound exchange described
above is on you, against your own IdP, before the token ever reaches this
console.

## Signing in with PingOne (OIDC)

Set the `OIDC_*` variables in `.env.local` (see `.env.local.example`) and a
"Sign in with PingOne" button appears in the top bar; leave them unset and
the app just runs in manual-paste mode, no code changes needed either way.

What actually happens on login:

1. The app generates a fresh PKCE `code_verifier`/`code_challenge` (S256),
   `state`, and `nonce`, and redirects you to your PingOne tenant's
   authorization endpoint — found via `OIDC_DISCOVERY_URL`, not hardcoded.
   The discovery document also supplies the token endpoint and JWKS URI, so
   there's exactly one URL to configure, not three.
2. You authenticate with PingOne directly — this app never sees your
   password, and never even sees an intermediate authorization code without
   also holding the matching PKCE verifier, which makes the code useless to
   anyone who intercepts the redirect alone.
3. On the callback, the app exchanges the code for tokens **server-side**
   (`client_id` + `client_secret`, confidential client), and verifies the ID
   token's signature against PingOne's JWKS, issuer, audience, and `nonce` —
   all before trusting anything in it.
4. The access token is sealed into an `HttpOnly`, `SameSite=Lax` cookie
   using **JWE (AES-256-GCM authenticated encryption)** — not a JWT you
   could inspect with a base64 decoder, not a signed-but-readable value, an
   actually encrypted one. Your browser stores it and sends it back on every
   request, but has no way to read or modify what's inside. `Secure` is
   forced on outside local dev.
5. `/api/invoke` decrypts that cookie server-side per-request to get the
   real access token, and that's the only place in the whole app it exists
   as plaintext outside PingOne itself.

Signing out does more than delete that cookie. Clearing only the local
cookie would leave PingOne's own SSO session alive — the next "Sign in"
click would then silently re-authenticate through it, no login prompt, no
real sign-out. So "Sign out" clears the local session first, unconditionally,
then sends the browser through PingOne's own end-session endpoint
(RP-Initiated Logout) to actually end that session too, before landing back
here. That second part needs `OIDC_POST_LOGOUT_REDIRECT_URI` registered as a
"Sign Off URL" on the PingOne application — same requirement as the login
redirect URI, just for the other direction. If it's not registered, sign-out
still works (you're always signed out of this app), it just won't reach
PingOne's own session on top of that.

Built on [`openid-client`](https://github.com/panva/openid-client) and
[`jose`](https://github.com/panva/jose) (same maintainer, the de facto
standard pair for this in Node) rather than hand-rolled token exchange or
JWT verification — PKCE, state/nonce CSRF checks, and JWKS-based signature
verification are exactly the kind of protocol logic that's easy to get
subtly, quietly wrong by hand, and this isn't the place to find out.

## Agent authentication + token exchange

Everything above is about *your* identity. The "Authenticate Agent" button
(next to the JWT field) is about proving a second one — the agent's own —
and then combining the two into a single delegated token. One click, two
OAuth calls, both entirely server-side:

**1. Client Credentials Grant.** A second, separate PingOne application
(its own `client_id`/`client_secret`, configured via `AGENT_*` in
`.env.local`) authenticates directly to the token endpoint with HTTP Basic
auth and a `scope` of `agent`. No browser redirect, no user, no consent
screen — the agent is simply proving its own identity, which is why the
button says *authenticate*, not *authorize*: there's no resource owner here
to grant anything. This produces the agent's own access token — the
**actor_token** for the next step.

**2. RFC 8693 Token Exchange.** That actor_token, together with *your*
signed-in OIDC access token as the **subject_token**, gets POSTed back to
the same token endpoint with
`grant_type=urn:ietf:params:oauth:grant-type:token-exchange` — exactly the
delegation pattern [AgentCore Identity's own on-behalf-of exchange](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/on-behalf-of-token-exchange.html)
uses internally, just performed here explicitly rather than by AWS. The
result is one access token that carries *both* identities — the real user
and this specific agent — which is exactly what AgentCore's authorizer
needs to see. This step requires you to already be signed in; the button
will tell you plainly if you're not, rather than failing partway through.

Nothing about either step touches the browser beyond a plain
`{ ok: true }` — same reverse-proxy shape as sign-in. Three cookies end up
involved (your session, the agent's own token, the final exchanged one),
each encrypted independently, and **the exchanged token is what actually
gets sent to AgentCore** once it exists — it now takes priority over both
your plain session token and a manually pasted JWT.

## Live OpenTelemetry — tokens, identity, audit

Every identity-bearing call this console makes — sign-in, sign-out, the
agent proving its own identity, the RFC 8693 exchange, and the call to
AgentCore itself — is wrapped in a real [OpenTelemetry](https://opentelemetry.io/)
span, visible live in the sidebar. This isn't a simulated activity feed;
it's actual instrumentation (`@opentelemetry/api` +
`@opentelemetry/sdk-trace-node`) that happens to keep its spans in memory
rather than shipping them to a collector, because there isn't one
configured by default.

Deliberately **not** a latency dashboard — nothing here measures how fast a
call was. It's built around the three things that actually matter for an
agent identity system:

- **Tokens.** Once AgentCore reports usage on the streamed response, input/
  output/total token counts land directly on the `agentcore.invoke` span —
  the same numbers a "last response metrics" panel would have shown, just
  attached to the call that produced them instead of floating separately.
- **Identity.** Every span that involves a credential records *whose* —
  the signed-in user's `sub`, the agent's own `client_id`, which of
  exchanged/session/manual token actually served a given call to AgentCore.
- **Audit.** A grouped, timestamped, success/fail trace of what happened:
  sign-in redirect → callback, the agent's client_credentials grant nested
  under its token exchange (real parent/child spans, not just a flat list),
  and the eventual AgentCore call — each one clearly marked `OK` or
  `ERROR`, with the failure reason attached when it isn't `OK`.

What never appears on a span: the token itself, or anything shaped like
one. Attributes are an explicit allowlist set by each route (`identity.sub`,
`identity.client_id`, `token.input`, `aws.region`, and so on) — never a
dump of request/response data — and a second, independent filter drops any
attribute whose *key* even looks like it might hold a secret
(`token`/`secret`/`password`/`authoriz`, case-insensitive) before it's
stored or logged, in case a future change ever tries to set one directly.

No OTLP exporter is wired up out of the box — there's nowhere to point one
by default — so none of this leaves your machine. See the OpenTelemetry
section in `CLAUDE.md` if you want to point it at a real collector.

## Secret scanning

Every push and pull request runs [Gitleaks](https://github.com/gitleaks/gitleaks)
against the full commit history (`.github/workflows/secret-scan.yml`) — via
its open-source CLI directly through the official Docker image, not the
`gitleaks-action` wrapper, which requires a paid license for org-owned repos
and is set to stop working once GitHub retires Node 20 runners. The
underlying scanner is free regardless of account type; this setup doesn't
depend on either of those.

Locally, the same `.env*` gitignore rule that keeps `.env.local` out of git
also means there's nothing account-specific — region, harness ARN, PingOne
client secret, session encryption key — for the scanner, or a reviewer, to
trip over. The JWT itself was never a candidate for a file in the first
place; see above.

## Quick start

```bash
npm install
cp .env.local.example .env.local   # fill in what you have — all of it is optional
npm run dev
```

Everything in `.env.local` is optional and independent: fill in the region
and harness ARN to pre-fill the Connection panel, fill in the `OIDC_*`
values to get a "Sign in with PingOne" button, or leave it all blank and
paste a JWT by hand every time. Open
[http://localhost:3000](http://localhost:3000) and go. Toggle dark mode
from the top bar; it persists across reloads.

### Or run it in Docker

```bash
docker compose up --build
```

That's the whole thing — no `.env.local` required to start (manual
JWT-paste mode works out of the box). If you have one, it's picked up
automatically and the container comes up already signed-in-capable:

```bash
cp .env.local.example .env.local   # if you haven't already
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). `docker compose down`
to stop it. See the Docker section in `CLAUDE.md` for what the image
actually contains, how the three `NEXT_PUBLIC_*` Connection-panel defaults
get baked in vs. everything else staying runtime-only, and the health
check at `/api/health`.

## How it works

1. **`src/app/api/invoke/route.ts`** — receives `{ region, harnessArn,
   qualifier, sessionId, messages }` from the browser (plus `jwt`, only if
   you're not signed in), calls AgentCore's `InvokeHarness` endpoint with
   the resolved bearer token — the exchanged token if one exists, else your
   plain session token, else the pasted JWT — and decodes the streamed
   event-stream binary frames (`@smithy/eventstream-codec`) as they arrive,
   buffering only enough bytes to complete one frame at a time, never the
   whole response.
2. Each decoded frame is re-emitted to the browser as a hand-rolled
   server-sent event over the same connection (plain `EventSource` can't
   POST or set custom headers, so both ends parse SSE manually — see
   `AgentConsole.tsx`).
3. The client renders `contentBlockDelta` text as it streams, through
   `react-markdown` + `remark-gfm`, while every raw event — `messageStart`,
   `contentBlockDelta`, `metadata`, errors, all of it — shows up live in the
   "Raw event stream" panel so you can see exactly what AgentCore sent, not
   just the rendered result.
4. Signing in instead of pasting a JWT runs through `/api/auth/login` →
   PingOne → `/api/auth/callback` first (see the OIDC section above), which
   ends with an encrypted cookie instead of a token landing in the browser.
5. "Authenticate Agent" runs a second, independent identity through client
   credentials, then exchanges it with your session token (RFC 8693) into
   one delegated token — see the Agent authentication section above.

Full architecture notes, AgentCore API gotchas (harness-vs-runtime ARNs,
the `:event-type` header colon-prefix that silently breaks naive parsing,
session-ID validation quirks), the OIDC flow's internals, and conventions
live in `CLAUDE.md` — read that before making structural changes.

## Environment variables

Next.js has no separate config-file convention — it reads `.env.local` via
`process.env`. Only `NEXT_PUBLIC_*`-prefixed vars reach the browser bundle;
everything else (`OIDC_CLIENT_SECRET`, `AGENT_CLIENT_SECRET`, `SESSION_SECRET`,
all of the `OIDC_*`/`AGENT_*` config) is server-only by construction, read
from separate modules (`src/lib/oidc.ts`, `src/lib/auth-session.ts`) that a
client component can't import. See `.env.local.example` for the full list.
The JWT is never one of them either way — pasted manually, it's typed into
the UI at runtime; via OIDC or agent auth, the resulting token never exists
as an env var or a file, only inside its own encrypted cookie.

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
binary framing · `openid-client` + `jose` for OIDC and encrypted sessions.
