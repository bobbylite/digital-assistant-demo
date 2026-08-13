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
- **`src/components/AgentConsole.tsx`** — the only stateful component. Owns
  connection config, session id, conversation history, and the fetch +
  manual SSE-parsing loop. Everything else in `src/components/` is
  presentational (`ChatPanel`, `ConnectionPanel`, `SessionPanel`,
  `MetricsPanel`, `EventConsole`, `TopBar`, `Panel`).
- **`src/lib/types.ts`** — shared `ChatMessage`/`ResponseMetrics`/`AuthSession`
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
- `src/app/api/invoke/route.ts` — prefers the session cookie's access token
  over `body.jwt` when both are absent/present; falls back to `body.jwt` if
  there's no session. This is why `InvokeRequestBody.jwt` is optional now.
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
etc. also work but aren't used here) directly via `process.env.NAME` at
build/dev time. Only vars prefixed `NEXT_PUBLIC_` get inlined into the
client bundle; anything else is server-only. Since `AgentConsole.tsx` is a
`"use client"` component, its defaults must use that prefix.

- `src/lib/env.ts` — client-safe connection defaults only
  (`process.env.NEXT_PUBLIC_*` with fallbacks), re-exported as plain
  constants. Safe to import from a `"use client"` file.
- `src/lib/oidc.ts` — server-only OIDC config (`OIDC_*`). **Never** import
  this from a `"use client"` file — it's the module boundary that keeps
  `OIDC_CLIENT_SECRET` out of the browser bundle. There's no build-time
  guard against getting this wrong beyond "it's just `undefined`" client-side
  if you did; don't rely on that, keep the boundary clean by construction.
- `src/lib/auth-session.ts` — same server-only rule, reads `SESSION_SECRET`.
- `.env.local` — your real values (gitignored, never committed).
- `.env.local.example` — committed template; the `.gitignore` has an
  explicit `!.env*.example` exception so template files stay trackable
  despite the broader `.env*` ignore rule. **Never fill in a real secret
  here** — this file is committed. (Yes, this happened once while building
  the OIDC feature — a generated `SESSION_SECRET` briefly landed in the
  example file instead of `.env.local`. Caught before commit, but the
  mistake is exactly the shape the secret-scan CI exists to catch.)
- `env.d.ts` — types `NodeJS.ProcessEnv` for all of the above (editor
  autocomplete only; doesn't enforce anything at runtime).

Only the connection *defaults* (region, qualifier, harness ARN) and the
OIDC client config are env-driven. The JWT itself is never env-sourced when
pasted manually; when signed in via OIDC, the resulting access token lives
only inside the encrypted session cookie (see the OIDC section above), never
server-side storage and never a plaintext value the browser can read.

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
- **Nothing token-shaped gets persisted server-side or logged**, manual-paste
  or OIDC alike. Manual: the JWT lives in React state + `sessionStorage`
  (client only), forwarded per-request. OIDC: the access token lives only
  inside the encrypted `agentcore_session` cookie; the one place it exists
  as plaintext server-side is the brief window inside `/api/invoke`'s
  request handler after decrypting the cookie and before the upstream
  `fetch` call. Don't add logging of `jwt`, `Authorization`, `accessToken`,
  or the raw session cookie value anywhere.
- This app has no test suite; verify changes with `npm run dev` + a real
  (or at least well-formed) JWT and harness ARN, and watch the "Raw event
  stream" panel — it's the fastest way to see whether a protocol-level
  change actually worked. For the OIDC flow specifically, see the testing
  note in that section above — use a mock IdP, don't assume a real PingOne
  tenant is available.
