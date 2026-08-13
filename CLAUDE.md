@AGENTS.md

# AgentCore Console

A local Next.js app for streaming chat responses from an **Amazon Bedrock
AgentCore harness**, authenticated with a JWT pasted directly into the UI.
Styled after pingidentity.com/en.html: off-white canvas, near-black navy
ink, Montserrat, a single flat red brand accent (no gradients, sharp CTA
corners, small-radius cards), plus a dark "console" panel for raw protocol
output. Palette/type tokens in `src/app/globals.css` were sampled from that
site's actual computed styles (see git history for the extraction), not
guessed — if restyling again, re-sample rather than eyeballing it.

The app supports two ways of authenticating to AgentCore: pasting a bearer
JWT directly, or signing in via OIDC (Authorization Code + PKCE against a
PingOne tenant) — see the OIDC section below. Both end up at the same
`/api/invoke` proxy either way.

## Why this exists

Bedrock AgentCore's `InvokeHarness` API only exposes a raw HTTPS endpoint —
no SDK support for bearer-token (JWT) auth, and the streaming response body
is AWS's binary `application/vnd.amazon.eventstream` framing, not plain
JSON or plain SSE. A browser can't call the endpoint directly (CORS, plus
nobody wants to hand-decode binary framing in the DOM), so this app is a
thin Next.js server that does the real HTTPS call and re-emits it as
same-origin SSE the browser can read trivially.

## Architecture

- **`src/app/api/invoke/route.ts`** — POST route handler. Takes
  `{ jwt, region, harnessArn, qualifier, sessionId, messages }` from the
  browser, calls `https://bedrock-agentcore.{region}.amazonaws.com/harnesses/invoke?harnessArn=...&qualifier=...`
  with `Authorization: Bearer {jwt}`, and decodes the AWS event-stream
  framing chunk-by-chunk using `@smithy/eventstream-codec`. Each decoded
  frame is re-emitted to the client as `event: {type}\ndata: {json}\n\n`
  (hand-rolled SSE over a `ReadableStream`, not `EventSource` — `EventSource`
  can't do POST or custom headers, which is why the client parses this by
  hand too; see `AgentConsole.tsx`).
- **`src/components/AgentConsole.tsx`** — the only stateful component that
  matters for the chat/connection flow. Owns connection config, session id,
  conversation history, and the fetch + manual SSE-parsing loop. Everything
  else in `src/components/` is presentational (`ChatPanel`, `ConnectionPanel`
  — which also owns the session-id field/regenerate control, see below —
  `TelemetryPanel`, `EventConsole`, `TopBar`, `Panel`), except
  `AgentAuthButton`, which owns its own small self-contained state machine
  (idle/loading/success/error) — it doesn't need anything from `AgentConsole`
  beyond two booleans, so it wasn't worth lifting.
- **`src/lib/types.ts`** — shared `ChatMessage`/`AuthSession`/`RecordedSpan`
  shapes, mirroring the AgentCore harness message format (`{ role, content: [{ text }] }`).
- **`src/lib/session.ts`** — generates the AWS-required AgentCore session id.
  Not to be confused with `src/lib/auth-session.ts` (the OIDC login session) —
  same word, two unrelated "sessions"; the AgentCore one is a per-conversation
  correlation ID, the auth one is "who's signed in."

## AgentCore harness API notes (learned the hard way)

- A **harness** is a config-only managed agent; its underlying **Runtime**
  ARN (`.../runtime/harness_...`) is *not* directly invokable — you get
  `"managed by a harness"` if you try. Use the harness's own ARN
  (`.../harness/{name}-{suffix}`) with `InvokeHarness`, not `InvokeAgentRuntime`.
- The harness ARN goes in a **query param** (`?harnessArn=...`), unlike
  plain Runtime invocation where the ARN is URL-encoded into the *path*.
- `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header is **required**,
  33–100 chars, `[a-zA-Z0-9][a-zA-Z0-9-_]*`. Missing/empty gives a
  `ValidationException` naming the field `runtimeSessionId` even though
  it's sent as a header, not a body field — don't let that name fool you
  into looking in the wrong place.
- Response body is streamed AWS event-stream binary framing regardless of
  client — this is not optional/negotiable via `Accept` headers. Always
  decode it (server-side here) rather than trying to read it as text.

## OIDC sign-in

Alternative to pasting a JWT: Authorization Code + PKCE (S256) against a
PingOne tenant, ending in an encrypted session cookie instead of a token in
the browser. This is additive — with no `OIDC_*` env vars set, `isOidcConfigured()`
returns `false`, the sign-in button never renders, and manual paste keeps
working exactly as before. Don't make any of this required.

**Files:**
- `src/lib/oidc.ts` — server-only. Reads `OIDC_*` env vars and discovers the
  IdP (`openid-client`'s `discovery()`), caching the resulting `Configuration`
  at module scope (a promise cache, not a TTL cache — it lives for the
  process lifetime; restart the dev server if you change `OIDC_DISCOVERY_URL`).
- `src/lib/auth-session.ts` — server-only. Encrypts/decrypts cookies via
  `jose`'s `EncryptJWT`/`jwtDecrypt` (JWE, `alg: dir`, `enc: A256GCM`, key =
  SHA-256 of `SESSION_SECRET`). Two cookies: `agentcore_oidc_pending` (short-lived,
  holds the PKCE `code_verifier` + `state` + `nonce` between the `/login`
  redirect and the `/callback` request) and `agentcore_session` (the real
  session, holds the AgentCore access token + minimal user claims).
- `src/app/api/auth/{login,callback,logout,session}/route.ts` — the flow
  itself. `login` builds the authorization URL and seals the pending cookie;
  `callback` calls `authorizationCodeGrant()` (validates `state`, does the
  token exchange with PKCE, verifies the ID token's signature/issuer/audience/
  nonce/expiry against the IdP's JWKS — all inside that one call) and seals
  the real session cookie, including the `id_token` (needed later for
  logout, see below); `session` is what the browser polls to know "am I
  signed in, as whom" without ever seeing the access token.
- **`logout` is GET, not POST, on purpose.** Clearing our own
  `agentcore_session` cookie is not enough — PingOne's own SSO session
  survives that, so the next "Sign in" click would silently re-authenticate
  through it without ever showing a login prompt. Full sign-out needs the
  *browser* to visit PingOne's `end_session_endpoint` (RP-Initiated Logout)
  carrying PingOne's own cookies, which a background `fetch` can't trigger —
  only a real top-level navigation can. So `AuthControl`'s sign-out is a
  plain `<a href="/api/auth/logout">`, matching how `login` already works.
  The route clears the local cookie *first, unconditionally* (so the user is
  signed out of this app even if everything after fails), then — only if
  `isOidcConfigured()`, the session had an `id_token`, and the IdP actually
  advertises `end_session_endpoint` in its discovery metadata — redirects to
  it with `id_token_hint` + `post_logout_redirect_uri`
  (`OIDC_POST_LOGOUT_REDIRECT_URI`, must be registered as a "Sign Off URL"
  on the PingOne application, same idea as the login redirect URI). Any
  failure in that second part (unregistered sign-off URL, IdP down) fails
  soft to a local-only redirect home — never leaves the user stuck.
- `src/app/api/invoke/route.ts` — bearer token priority: exchanged token >
  session cookie's access token > `body.jwt`. Falls back down that chain as
  each is absent. This is why `InvokeRequestBody.jwt` is optional now. See
  the Agent authentication section below for the exchanged-token piece.
- `src/components/AuthControl.tsx` / `TopBar.tsx` / `AgentConsole.tsx` — UI.
  `AgentConsole` fetches `/api/auth/session` once on mount (not on every
  render) and holds it in state; `ConnectionPanel`'s JWT field is replaced
  with a note when `signedIn` is true rather than being hidden, so it's
  obvious *why* the field doesn't matter instead of it just vanishing.
  `AuthControl` itself is a plain (non-`"use client"`) component — both its
  sign-in and sign-out controls are just `<a href>` full navigations, no
  client-side state or handlers needed.

**Why `openid-client` and `jose` instead of hand-rolled fetch calls:** PKCE
challenge generation, state/nonce CSRF checks, and — especially — ID token
signature verification against a JWKS endpoint are exactly the kind of thing
that's easy to get subtly wrong (algorithm confusion, skipped expiry/audience
checks, timing issues fetching/caching JWKS) and expensive to get wrong
quietly. `openid-client` is maintained by the same author as `jose` (panva)
and is the de facto standard RP library for Node; use it rather than adding
hand-rolled protocol logic here.

**HTTPS enforcement:** `openid-client` refuses plain `http://` to the IdP by
default. `getOidcConfiguration()` has a narrow escape hatch
(`client.allowInsecureRequests`) gated on `NODE_ENV !== "production"` **and**
the discovery URL actually being `http:` — it exists solely so a local
mock/dev IdP works in tests (see below), never fires against a real `https://`
PingOne tenant, and can never fire in production. Do not widen this gate.

**Client authentication method is not universal.** `openid-client` defaults
to `client_secret_post` when you pass a bare secret string to `discovery()`.
This PingOne application requires `client_secret_basic` (HTTP Basic,
RFC 6749 §2.3.1) instead — its token endpoint returns
`invalid_client: Unsupported authentication method` otherwise, which reads
like a config problem on our end but is really just "wrong auth method
selected." `getOidcConfiguration()` now passes `client.ClientSecretBasic(...)`
explicitly rather than relying on the default. If you ever swap PingOne
applications, check this first if login starts failing with `invalid_client`.

**Testing this without a real PingOne tenant:** there's no test suite in
this repo, but this flow (login *and* logout) was verified against a
hand-rolled mock IdP (plain Node `http` server implementing
discovery/authorize/token/jwks/signoff, signing real RS256 tokens via
`jose`) driven through the actual `/api/auth/*` routes with manual
cookie-jar handling in a small script — full login → callback →
encrypted-cookie → `/api/invoke` round trip, then logout → confirming the
session cookie is cleared *before* the IdP redirect, that the redirect to
`end_session_endpoint` carries `id_token_hint` and `post_logout_redirect_uri`,
and that the mock IdP's own `/signoff` accepts it and redirects back — plus
confirming the session response never contains anything token-shaped. That
script was temporary (written to the repo root, deleted after use) rather
than a committed test — recreate the same approach if you touch this flow,
rather than trusting a type-check and a build alone. Non-obvious gotchas it
caught, in case you hit them again:
- `openid-client`'s HTTPS-only default has to be disabled at
  `discovery()`-call time via `options.execute`, not after — you cannot call
  `allowInsecureRequests` on a `Configuration` you don't have yet.
- If your mock IdP decodes `client_secret_basic`'s Authorization header by
  hand, remember RFC 6749 §2.3.1 requires the credentials to be
  `application/x-www-form-urlencoded` *before* the base64 join —
  `openid-client` encodes them that way, so a naive base64-decode-and-split
  on the mock side will see percent-escaped values (`test%2Dclient`) and
  falsely look like a client_id mismatch. That's a mock-server bug, not an
  app bug, but it's easy to misread as the latter.

## Agent authentication + RFC 8693 token exchange

Clicking "Authenticate Agent" runs a two-step server-side flow, both steps
inside the single `POST /api/auth/agent-token` request:

1. **Client Credentials Grant** — a second, independent PingOne application
   (the agent's own `client_id`/`client_secret`, not the user-login one)
   authenticates directly to the token endpoint. No user, no browser
   redirect, no consent screen — the agent just proves its own identity.
   The result (`actor_token`) is sealed into `agentcore_agent_token`.
2. **RFC 8693 Token Exchange** — that `actor_token`, together with the
   signed-in user's own OIDC access token as `subject_token`, gets POSTed
   back to the *same* token endpoint with
   `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` (HTTP Basic
   auth, agent's credentials). The result is one delegated access token
   carrying both identities — real user *and* this specific agent — sealed
   into `agentcore_exchanged_token`. **This is the token `/api/invoke`
   actually sends to AgentCore** when present (see priority order there).

Step 2 requires step 1's result, and requires the user to already be
signed in (there's no subject_token otherwise) — `/api/auth/agent-token`
checks for a user session *before* doing anything else and fails fast with
a clear message if there isn't one, rather than burning a client-credentials
round trip on a flow that can't finish.

**Files:**
- `src/lib/oidc.ts` — `getAgentConfiguration()` does its own independent
  `discovery()` call against `OIDC_DISCOVERY_URL` (same discovery doc as
  user login, different client) rather than reusing `getOidcConfiguration()`'s
  cached `Configuration` — deliberate, so agent auth doesn't require
  `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` (user login) to be configured, or
  vice versa. Also pinned to `client_secret_basic`, same reasoning as the
  user-login config. The same `Configuration` (and thus the same client
  auth) is reused for both the client_credentials grant and the token
  exchange — both are the agent authenticating itself, just for different
  grant types.
- `src/lib/auth-session.ts` — three *separate* cookies:
  `agentcore_session` (user, from OIDC login), `agentcore_agent_token`
  (agent's own actor_token), `agentcore_exchanged_token` (the final
  delegated token). Kept apart rather than collapsed into one, because
  they're genuinely three different things with independent lifecycles —
  re-running the exchange doesn't require re-running login, and the raw
  agent token stays valid/inspectable even though `/api/invoke` doesn't use
  it directly. All three: short max-age (agent/exchanged: 1 hour; these are
  meant to be re-minted often, not treated as long-lived sessions).
- `src/app/api/auth/agent-token/route.ts` — **POST that returns JSON, not a
  redirect**, for both steps. Unlike `/login`, neither Client Credentials
  Grant nor Token Exchange needs any browser interaction — both are pure
  back-channel calls to the token endpoint. The browser's `fetch` just gets
  `{ ok: true }` or `{ error: "..." }` back; neither resulting token ever
  appears in a response body, only inside their cookies, set server-side.
  No dedicated `openid-client` helper exists for the token-exchange grant
  type (it's not one of the common ones like `authorization_code` or
  `refresh_token`), so this uses `genericGrantRequest()` — that function's
  own doc comment cites RFC 8693 Token Exchange as its primary example.
  If step 1 succeeds but step 2 fails, the error response says so
  explicitly ("Agent authenticated, but token exchange failed: ...")
  rather than just surfacing the exchange error alone — otherwise a
  half-succeeded state is confusing to read.
- `src/app/api/invoke/route.ts` — bearer token priority is now
  **exchanged > user session > manually pasted JWT**. The exchanged token
  wins whenever it exists because it's the one actually shaped to satisfy
  AgentCore's authorizer (real user `sub`, agent's own `client_id`); the
  other two are documented fallbacks from earlier in this build, not
  removed.
- `src/components/AgentAuthButton.tsx` — client component, self-contained
  (owns its own loading/success/error state, doesn't need session state
  from a parent beyond the two booleans `configured` /
  `initiallyAuthenticated`). Success replays a CSS animation
  (`.animate-agent-ping-ring` + `.animate-agent-check-pop` in `globals.css`)
  by bumping a `burstKey` state value used as the animated elements' `key` —
  React won't restart a CSS animation on a DOM node whose props/key didn't
  change, so re-clicking "authenticate" without that key bump would only
  animate the *first* time.

**Env:** `AGENT_CLIENT_ID`, `AGENT_CLIENT_SECRET`, `AGENT_SCOPE` (default
`"agent"`, used on the client_credentials grant), `AGENT_EXCHANGE_SCOPE`
(default `"agent:exchange"`, used on the token-exchange request — a
*different* scope parameter than `AGENT_SCOPE`, don't conflate them). No
separate discovery URL — reuses `OIDC_DISCOVERY_URL`. `isAgentConfigured()`
also requires `SESSION_SECRET` (needed to seal the cookies) but deliberately
does *not* require the `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` pair — though in
practice the exchange step needs a user session to exist regardless, since
sign-in uses that pair.

**Naming:** the button says "Authenticate," not "Authorize" — both the
client_credentials grant and the token exchange are the agent proving
identity (authentication), not a resource owner granting consent
(authorization) — there's no user-facing consent step in either. Keep that
distinction if you touch the copy.

**Tested against a mock IdP** (extended the same one used for OIDC
login/logout, with `grant_type=client_credentials` and
`grant_type=urn:ietf:params:oauth:grant-type:token-exchange` support, a
second registered client of `kind: "agent"`, and real signature
verification of the subject/actor tokens before minting an exchanged one)
via `curl` with a cookie jar (`-c`/`-b`) driving the actual routes — full
login → agent-token (both steps) → confirmed all three cookies land
correctly, that `agentAuthenticated` in `/api/auth/session` only flips true
once the *exchange* succeeds (not just the client_credentials half), that
attempting the button without signing in first fails fast with the right
message, and that `/api/invoke` genuinely prefers the exchanged token —
proved by presenting *only* the exchanged cookie (no user session cookie at
all) and confirming the request still reached real AWS (got a real
`"Invalid harness ARN format"` response back, not the "no bearer token"
401) rather than trusting that it merely avoided an error. Same
"recreate the mock, don't trust a build alone" rule as the OIDC section above.

## OpenTelemetry

Every identity/token operation in this app — OIDC login/callback/logout, the
agent's client_credentials grant, the RFC 8693 token exchange, and the
`/api/invoke` call to AgentCore — is wrapped in a real OpenTelemetry span
(`@opentelemetry/api` + `@opentelemetry/sdk-trace-node`), not a
fake/simulated timeline built from ad-hoc timestamps. This was added
deliberately scoped to **identity, audit, and token usage**, not
performance/latency — the panel shows a timestamp per span but no
duration, and nothing here is meant to answer "how slow was this."

**Files:**
- `src/lib/telemetry.ts` — server-only. `initTelemetry()` registers a
  `NodeTracerProvider` with one custom `SpanProcessor`
  (`RecordingSpanProcessor`) that keeps the last `MAX_SPANS` (300) spans in
  an in-memory ring buffer and mirrors each one as a compact one-line
  console log. `withSpan(name, attributes, fn)` is what most routes use —
  wraps `tracer.startActiveSpan`, sets attributes up front, auto-records
  `OK`/`ERROR` status (via `recordException` on throw) and always ends the
  span, even on error. `TRACER_NAME` is exported so any route creating a
  manual span (see `/api/invoke` below) tags it consistently.
- `src/instrumentation.ts` — Next.js's own convention: `register()` runs
  once at server startup, before any request is handled, and calls
  `initTelemetry()`. **Must live inside `src/`**, not the project root, for
  a project using a `src/` layout — Next silently ignores it at the wrong
  path with no error, which is exactly what happened building this the
  first time. Gated on `process.env.NEXT_RUNTIME === "nodejs"` since this
  file also runs (harmlessly, but pointlessly) in the Edge runtime.
- `src/app/api/telemetry/spans/route.ts` — `GET` returns `{ spans }`
  (newest first) for the panel to poll; `DELETE` clears the buffer (wired
  to the panel's "Clear" button).
- `src/components/TelemetryPanel.tsx` — polls `GET /api/telemetry/spans`
  every 2.5s, groups spans by `traceId` (root span first, children
  indented under it via `parentSpanId`), and renders each with a status
  dot, a human label, its timestamp, and attribute chips — token-usage
  attributes (`token.input`/`token.output`/`token.total`) get distinct
  styling from identity (`identity.*`) and AWS (`aws.*`) attributes, plus
  a monospace trace/span ID footer for anyone who wants to correlate with
  the console output.
- `src/lib/types.ts` — `RecordedSpan` (the redacted, client-safe shape a
  span gets flattened to) lives here rather than in `telemetry.ts` so
  `TelemetryPanel.tsx` (a client component) can import the type without
  pulling in server-only OTel SDK code.

**No OTLP exporter is configured** — there's no collector to point one at
by default, so spans never leave the process; the in-memory buffer and
console mirror are the only sinks. If you want these to actually leave the
process (Honeycomb, Jaeger, an OTel Collector, etc.), add
`@opentelemetry/exporter-trace-otlp-http`, construct a `BatchSpanProcessor`
wrapping it, and add it to the `spanProcessors` array passed to
`NodeTracerProvider` in `initTelemetry()` — `RecordingSpanProcessor` can
keep running alongside it unchanged, since a `TracerProvider` fans the same
spans out to every processor in the array.

**Spans, by route:**
- `oidc.login.redirect` (`/api/auth/login`) — `identity.client_id`,
  `identity.scope`.
- `oidc.login.callback` (`/api/auth/callback`) — `identity.sub`,
  `token.expires_in_s`. Every failure branch (`expired_login`,
  `discovery_failed`, `incomplete_response`, `exchange_failed`) throws a
  local `CallbackError(code, message, detail)` so `withSpan` records it as
  an `ERROR` span automatically; an outer try/catch converts it back into
  the existing redirect-with-`auth_error`-query-param response, so span
  instrumentation didn't change any user-visible error behavior.
- `oidc.logout` (`/api/auth/logout`) — `identity.sub`,
  `logout.rp_initiated` (`true` only when the IdP actually advertises
  `end_session_endpoint` and the redirect happens).
- `agent.authenticate` (`/api/auth/agent-token`) — the outer span for the
  whole two-step flow, parenting two child spans (automatic, via
  `tracer.startActiveSpan`'s context propagation — no manual span-context
  plumbing needed):
  - `agent.client_credentials` — `identity.client_id`, `identity.scope`.
  - `agent.token_exchange` — `identity.subject_sub`,
    `identity.actor_client_id`, `identity.scope`, `token.requested_type`.
  Same pattern as the callback route: a local `AgentAuthError(message,
  status)` preserves the exact HTTP status this route already returned
  per failure case, while still getting automatic `ERROR` span recording.
- `agentcore.invoke` (`/api/invoke`) — `aws.region`, `aws.harness_arn`,
  `aws.qualifier`, `identity.token_source` (`exchanged`/`session`/`manual`
  — which credential actually served the call), `identity.sub` when
  known, and, once AgentCore's `metadata` stream event arrives,
  `token.input`/`token.output`/`token.total`. **This is the one route that
  uses `tracer.startSpan()` directly instead of `withSpan()`** — the span
  has to stay open across the entire SSE streaming lifecycle, which
  continues well after the route handler returns its `Response` object, so
  `withSpan`'s "await the function, then end the span" shape doesn't fit.
  Ended exactly once via a small idempotent `endSpan()` helper, from
  whichever of three places finishes first: the stream completing
  normally, a stream error, or the client disconnecting (the `cancel()`
  callback on the `ReadableStream`).

**Redaction is defense-in-depth, not a single check.** `withSpan`'s
`attributes` parameter is a plain object callers build explicitly — there's
no code path that dumps a request/response body onto a span, so nothing
token-shaped should ever reach one. `RecordingSpanProcessor.onEnd()` adds a
second, independent gate on top of that: any attribute key matching
`SUSPICIOUS_KEY_PATTERN` (`/token|secret|password|authoriz/i`) is dropped
before it's stored or logged, so even a future edit that sets an attribute
some other way can't leak a credential through this path. Identity *claims*
(`sub`, `client_id`, `scope`) are fine to record; the credentials that
carried them are not — same rule as everywhere else in this app.

**Next.js's own OpenTelemetry auto-instrumentation is on by default once
you register a global `TracerProvider`.** Framework-internal spans (e.g.
"resolve page components") started flowing into the same processor,
tagged with `instrumentationScope.name === "next.js"` instead of this
app's `TRACER_NAME` — flooded the console (56.9KB from just startup + one
page load) and would have flooded the in-memory buffer, burying the
spans this panel actually cares about. Fixed by filtering on
`span.instrumentationScope.name !== TRACER_NAME` as the very first line of
`onEnd()`. If spans stop showing up after touching this file, check that
filter hasn't been loosened or removed.

**Next.js/Turbopack dev-mode module-instance isolation bit this once,
learned the hard way:** `instrumentation.ts` (which dynamically
`import()`s `telemetry.ts` to call `initTelemetry()`) and the various
route handlers (which statically `import` the same module) can resolve to
*separate compiled instances* of `telemetry.ts` under Turbopack dev mode.
A plain module-level `const recentSpans: RecordedSpan[] = []` silently
became two independent arrays — `RecordingSpanProcessor.onEnd()` was
correctly pushing spans (confirmed via the console mirror), but
`GET /api/telemetry/spans` read from a *different* empty array and always
returned `{ spans: [] }`. `@opentelemetry/api`'s own cross-module tracer
registry doesn't have this problem (it's backed by `globalThis`
internally), which is why span *creation* worked fine while the buffer
*read-back* silently didn't. Fixed the same way this codebase already
fixes this exact class of bug for a Prisma client singleton: the buffer is
now `globalThis.__agentcoreRecentSpans`, accessed only through a
`spanStore()` helper, never a bare module-level variable. If you add
another piece of shared mutable state to a server-only module, default to
the `globalThis` pattern rather than a plain module-level variable, or
re-learn this the hard way too.

**Tested against the same mock IdP used for OIDC/agent-auth testing**
(extended with `client_credentials` and
`urn:ietf:params:oauth:grant-type:token-exchange` grant support), driven
by a small script doing a full login → `/api/auth/agent-token` → 
`GET /api/telemetry/spans` round trip and asserting: all five expected
span names are present, no Next.js-internal spans leaked through,
`agent.client_credentials`/`agent.token_exchange` are both children of
`agent.authenticate` and share its `traceId`, identity attributes
(`identity.sub`, `identity.actor_client_id`) are present, and no
JWT-shaped value (`/eyJ[A-Za-z0-9_-]{10,}/`) appears anywhere in any
span's attributes. Same "recreate the mock, don't trust a build alone"
rule as the OIDC and agent-auth sections above — the script was temporary
and deleted after use.

## Settings (runtime-editable config)

Everything env-configurable in this app splits into two groups:
`OIDC_*`/`SESSION_SECRET`, which have to be correct *before* anyone can sign
in (there's no bootstrapping path around that — chicken/egg), and
everything else (connection defaults, `AGENT_*`), which is now editable
from an in-app Settings panel (gear icon in the top bar, visible once
signed in) instead of only at deploy time. The intended deploy story: ship
a container with just the OIDC bits set, sign in once, then fill in the
rest through the UI — see the Docker section below for what that requires.

**Files:**
- `src/lib/settings.ts` — server-only. `getConnectionDefaults()` /
  `getRedactedSettings()` read straight from `process.env` (never a cache —
  a setting saved a moment ago must read back correctly on the very next
  request). `applySettings(input)` does two things for every changed key:
  updates `process.env` immediately (so the change is live for the *next*
  request, no restart) and best-effort patches `.env.local` on disk (so it
  survives one). Those two are allowed to disagree — a failed disk write
  returns `{ persisted: false, warning }` instead of throwing, so a
  container running with a read-only or unmounted `.env.local` still lets
  you change settings for the life of that process rather than making the
  feature unusable there. `patchEnvFile()` is a surgical line-based patch
  (rewrite matching `KEY=` lines in place, append new ones), not a
  parse-and-regenerate — the latter would silently drop every comment in
  the file on the first save.
- `src/lib/oidc.ts` — `resetAgentConfiguration()`. The cached agent
  `Configuration` from `getAgentConfiguration()` has the *old*
  `AGENT_CLIENT_ID`/`AGENT_CLIENT_SECRET` baked into it by
  `client.discovery()`; updating `process.env` alone doesn't change that.
  `applySettings()` calls this whenever either key is part of the update,
  forcing the next `getAgentConfiguration()` call to re-discover with the
  new credentials instead of silently keeping using the old ones.
- `src/app/api/config/route.ts` — `GET`, public, no auth. Returns
  `{ defaultRegion, defaultQualifier, defaultHarnessArn }`. This replaced
  the old `NEXT_PUBLIC_DEFAULT_*` build-time-inlined constants (see
  Environment variables below) — `AgentConsole.tsx` fetches this on mount
  instead of importing a baked-in module constant, which is what makes
  these editable without a rebuild in the first place. Public because
  these were already visible in the client bundle before this change;
  nothing about moving them to a runtime fetch made them more sensitive.
- `src/app/api/settings/route.ts` — `GET`/`POST`, gated on
  `getUserSession()` being non-null — same bar `/api/auth/agent-token`
  already uses, no separate admin/role concept exists in this app. `GET`
  never returns `AGENT_CLIENT_SECRET`, only `hasAgentClientSecret: boolean`
  — the settings form shows a "Unchanged" placeholder instead of an empty
  field that would misleadingly look unset. `POST` only overwrites the
  secret if the request body actually includes a non-empty
  `agentClientSecret`; omitting the key means "leave it alone." Wrapped in
  an OTel `settings.update` span recording *which fields* changed
  (`settings.fields`, a comma list of field names) — never a value, so the
  secret's actual contents never touch a span even indirectly. See the
  OpenTelemetry section above for why that pattern exists everywhere else
  in this app too.
- `src/components/SettingsButton.tsx` — self-contained client component
  (like `AgentAuthButton`), owns its own open/loading/saving state. Fetches
  current settings on open (not eagerly on mount — no reason to hit the
  endpoint before anyone's looked at it), calls the `onSaved` prop after a
  successful save so `AgentConsole` can re-fetch `/api/auth/session` and
  pick up a newly-configured `agentConfigured: true` without a page reload.
- `.env.local.example` — the three connection-default vars dropped their
  `NEXT_PUBLIC_` prefix (`DEFAULT_REGION`/`DEFAULT_QUALIFIER`/
  `DEFAULT_HARNESS_ARN`) since they're no longer client-bundle-inlined.
  If you're looking for old-named env vars from before this feature, this
  is the rename to make.

## Docker

`docker compose up --build` builds and runs the whole app. No `.env.local`
required to start — the app already treats every env var as optional (see
Environment variables below), and `docker-compose.yml`'s `env_file` entry
for `.env.local` is marked `required: false` so a fresh clone with no env
file still comes up, just in manual-JWT-paste mode, same as `npm run dev`
would.

**Files:**
- `next.config.ts` — `output: "standalone"`. This is what makes the runner
  stage below small: Next traces the actual production dependency subset
  used by the build into `.next/standalone`, instead of shipping the full
  `node_modules` tree (dev dependencies, unused transitive deps, all of
  it). Without this, the runner stage would need a full `npm install`.
- `Dockerfile` — three stages: `deps` (installs once, cached independently
  of source changes so editing app code doesn't invalidate the `npm ci`
  layer), `builder` (runs `next build` against the standalone output),
  `runner` (the shipped image — just `.next/standalone`, `.next/static`,
  and `public`, running as a non-root `nextjs` user on Alpine). **No
  build-time config at all** — every env var this app reads, including the
  connection defaults, is server-only and read from `process.env` at
  request time (see Settings above), so the same image works for any
  deployment's config without a rebuild. Health check runs
  `node -e "fetch(...)"` against `/api/health` rather than adding `curl`
  or `wget` to the Alpine image — Node 18+ has `fetch` built in, so this
  is one fewer package in the image for a check this simple.
- `src/app/api/health/route.ts` — deliberately answers only "is the Next.js
  process up and routing," not "is AgentCore/PingOne reachable." Don't add
  a downstream call here; a health check that depends on a third party
  turns their outage into this container's outage.
- `docker-compose.yml` — `env_file: [{path: .env.local, required: false}]`
  wires the same file `npm run dev` already reads straight into the
  container at runtime, no separate Docker-specific env file to maintain.
  The `volumes:` bind mount for `.env.local` is commented out by default —
  **do not uncomment it unless `.env.local` already exists on the host.**
  Docker's bind-mount behavior for a source path that doesn't exist yet is
  to silently create a *directory* there instead of a file (confirmed
  directly: `docker compose up` against a compose file bind-mounting a
  nonexistent `./testfile` created a `testfile/` directory on the host,
  not an error) — which then breaks both `env_file` (can't read a
  directory as env syntax) and every Settings-panel save (`patchEnvFile()`
  will throw `EISDIR`, surfaced as a non-persisted warning rather than a
  crash, but still not what you want). Run
  `cp .env.local.example .env.local` first, *then* uncomment the volume
  line, if you want settings saved from the UI to survive
  `docker compose down`. Without the mount, Settings changes still apply
  immediately to the running container (same `process.env` update either
  way) — they just don't outlive it.
- `.dockerignore` — excludes `.env*` except `.env.local.example`
  (mirroring `.gitignore`'s own exception, see Environment variables
  below), plus `node_modules`, `.next`, `.git`, and docs — keeps the build
  context small and guarantees no local secret can accidentally end up
  inside a build layer via a stray `COPY . .`.

**Alpine's `adduser --system` doesn't set a user's primary group from a
bare trailing group name** — `adduser --system --uid 1001 nextjs` silently
leaves the new user in Alpine's default `nogroup` rather than the `nodejs`
group created just before it, even though the `COPY --chown=nextjs:nodejs`
lines assume that pairing. Harmless in practice here (the copied files are
owned by `nextjs` directly, so owner-bit permissions cover it regardless of
group), but it's not the intended permission model and defeats the point of
creating a dedicated group at all. Fixed with the explicit `-G nodejs`
flag (BusyBox `adduser` syntax, confirmed via `adduser --help` inside the
`node:22-alpine` image itself rather than assumed from GNU `adduser`'s
different flag names) — verified via `docker compose exec app id` showing
`gid=1001(nodejs)` before trusting it, not just that the container started.

**Tested for real, not just "the build didn't error":** `docker compose
build` + `up -d`, then verified `docker compose ps` reports
`(healthy)` (not just `Up`), `GET /api/health` and `GET /` both return 200,
`docker compose exec app id` shows uid 1001 / gid 1001 (`nodejs`) — not
root — and `GET /api/auth/session` returned `oidcEnabled: true` /
`agentConfigured: true` against a real `.env.local`, proving the
`env_file` wiring actually reaches server-only config at runtime and isn't
just present in `docker-compose.yml` unused.

## Commands

```bash
npm run dev     # start dev server (Turbopack) on :3000
npm run build   # production build
npm run lint    # ESLint (flat config, eslint.config.mjs)
npx tsc --noEmit  # typecheck
```

## Environment variables

Next.js has no separate "env config file" convention like some frameworks —
it reads `.env.local` (gitignored, machine-specific; `.env`, `.env.production`,
etc. also work but aren't used here) directly via `process.env.NAME`.
Historically, vars prefixed `NEXT_PUBLIC_` got inlined into the client
bundle at build time for anything a `"use client"` component needed — this
app no longer uses that mechanism for anything (see Settings above for why:
build-time inlining is incompatible with changing a value at runtime without
a rebuild), so every var here, including the connection defaults, is plain
server-only `process.env`, read fresh per-request.

- `src/lib/settings.ts` — connection defaults (`DEFAULT_*`) and agent
  config (`AGENT_*`), both readable and (past initial deploy) writable at
  runtime — see Settings above.
- `src/lib/oidc.ts` — server-only OIDC config (`OIDC_*`), read-only via env
  (not editable through Settings — see above for why). **Never** import
  this from a `"use client"` file — it's the module boundary that keeps
  `OIDC_CLIENT_SECRET` out of the browser bundle. There's no build-time
  guard against getting this wrong beyond "it's just `undefined`" client-side
  if you did; don't rely on that, keep the boundary clean by construction.
- `src/lib/auth-session.ts` — same server-only rule, reads `SESSION_SECRET`.
- `.env.local` — your real values (gitignored, never committed). Also the
  file the Settings panel patches in place at runtime — see Settings above.
- `.env.local.example` — committed template; the `.gitignore` has an
  explicit `!.env*.example` exception so template files stay trackable
  despite the broader `.env*` ignore rule. **Never fill in a real secret
  here** — this file is committed. (Yes, this happened once while building
  the OIDC feature — a generated `SESSION_SECRET` briefly landed in the
  example file instead of `.env.local`. Caught before commit, but the
  mistake is exactly the shape the secret-scan CI exists to catch.)
- `env.d.ts` — types `NodeJS.ProcessEnv` for all of the above (editor
  autocomplete only; doesn't enforce anything at runtime).

Only the connection *defaults* (region, qualifier, harness ARN), the OIDC
client config, and the agent's client-credentials config (`AGENT_*`) are
env-driven. The JWT itself is never env-sourced when pasted manually; when
signed in via OIDC, the resulting access token lives only inside the
encrypted session cookie (see the OIDC section above), never server-side
storage and never a plaintext value the browser can read. Same for the
agent's own token (see Agent authentication above) — separate cookie, same
rule.

## Markdown rendering

Assistant messages (not user messages — those stay plain text) render
through `MarkdownMessage.tsx` (`react-markdown` + `remark-gfm`, styled via
`@tailwindcss/typography`'s `prose` classes, registered in `globals.css`
with `@plugin "@tailwindcss/typography";` — Tailwind v4's CSS-first plugin
syntax, not `tailwind.config.js`). Color overrides live inline as
`prose-*:` utility modifiers in `MarkdownMessage.tsx` rather than a
separate CSS file, so the palette stays in sync with the `--color-*` tokens
by construction. Streaming partial markdown (e.g. an unclosed `**`) is
expected to render as literal characters mid-stream and resolve once the
closing token arrives — this is normal for token-by-token markdown and
not a bug.

## Dark mode

Colors are plain `:root` custom properties (`--canvas`, `--ink`, `--brand`,
etc. in `globals.css`), with `@theme inline` just pointing Tailwind's
`--color-*` names at them — that indirection is what lets the dark
overrides below win by cascade instead of needing per-component dark:
classes. Three blocks define the same variable set: light values on bare
`:root`, dark values under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`
(system preference), and dark values again under `:root[data-theme="dark"]`
(explicit toggle wins either direction). If you add a new color token, it
needs a value in *all three* blocks or dark mode will silently fall back to
the light value for it.

`ThemeToggle.tsx` reads/writes `localStorage.theme` and sets
`document.documentElement.dataset.theme`. The tricky part is avoiding a
flash of the wrong theme on load: `layout.tsx` has a blocking inline
`<script>` (`THEME_INIT_SCRIPT`) that runs before hydration and applies the
stored preference synchronously — `ThemeToggle`'s own effect only syncs
React state to what's already painted, it doesn't set the attribute on
mount. Don't remove the layout.tsx script thinking the component handles
it; they're not redundant.

## Conventions

- **Fixed-height layout, no page scroll.** The root (`AgentConsole.tsx`) is
  `h-screen overflow-hidden`; the chat transcript and the sidebar each
  scroll internally (`min-h-0` + `overflow-y-auto` on the scrolling
  element, `flex`/`flex-col` down the whole ancestor chain so heights
  actually constrain instead of growing). If you add a new tall panel,
  give the *scrolling child* `min-h-0 overflow-y-auto`, not the panel
  itself — and remember every flex ancestor between it and the `h-screen`
  root needs `min-h-0` too, or the browser default (`min-height: auto`)
  will let content push the whole page taller instead of scrolling in
  place. The chat transcript also auto-scrolls to bottom on new messages
  (`ChatPanel.tsx`); do the same for any new streaming panel.
- **Tailwind v4, CSS-first config** — no `tailwind.config.js`. Design
  tokens are plain `:root` custom properties in `src/app/globals.css`
  (`--canvas`, `--surface`, `--ink`, `--ink-muted`, `--border`, `--brand`,
  `--brand-dark`, `--brand-light`, `--success`, `--danger`), with `@theme
  inline` pointing Tailwind's `--color-*` names at them — that indirection
  (not hardcoding hex directly in `@theme`) is what makes dark mode work by
  cascade. See the Dark mode section for why a new token needs three
  definitions, not one. Add new tokens there, not as arbitrary `[#hex]`
  values in components.
- Fonts: Montserrat (display/body, matches pingidentity.com) + Geist Mono
  (anything code/JWT/JSON-shaped — JWT field, harness ARN, session ID, the
  event console), both via `next/font/google`, wired in `layout.tsx`.
- Client components are explicit (`"use client"`); keep new presentational
  pieces as plain server components unless they need state/handlers.
- **Nothing token-shaped gets persisted server-side or logged**, manual-paste,
  OIDC, or agent/exchange alike. Manual: the JWT lives in React state +
  `sessionStorage` (client only), forwarded per-request. Everything else
  (user session, agent's own token, exchanged token) lives only inside its
  own encrypted cookie (`agentcore_session` / `agentcore_agent_token` /
  `agentcore_exchanged_token`); the one place any of them exists as
  plaintext server-side is the brief window inside a request handler after
  decrypting and before the next network call. Don't add logging of `jwt`,
  `Authorization`, `accessToken`, `subject_token`, `actor_token`, or any raw
  cookie value anywhere.
- This app has no test suite; verify changes with `npm run dev` + a real
  (or at least well-formed) JWT and harness ARN, and watch the "Raw event
  stream" panel — it's the fastest way to see whether a protocol-level
  change actually worked. For the OIDC flow specifically, see the testing
  note in that section above — use a mock IdP, don't assume a real PingOne
  tenant is available.
