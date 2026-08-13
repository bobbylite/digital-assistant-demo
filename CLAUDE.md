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
- **`src/lib/types.ts`** — shared `ChatMessage`/`ResponseMetrics` shapes,
  mirroring the AgentCore harness message format (`{ role, content: [{ text }] }`).
- **`src/lib/session.ts`** — generates the AWS-required session id.

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

- `src/lib/env.ts` — the single place these are read (`process.env.NEXT_PUBLIC_*`
  with fallbacks), re-exported as plain constants. Import from there, don't
  read `process.env` directly elsewhere.
- `.env.local` — your real values (gitignored, never committed).
- `.env.local.example` — committed template; the `.gitignore` has an
  explicit `!.env*.example` exception so template files stay trackable
  despite the broader `.env*` ignore rule.
- `env.d.ts` — types `NodeJS.ProcessEnv` for these three vars (editor
  autocomplete only; doesn't enforce anything at runtime).

Only the connection *defaults* (region, qualifier, harness ARN) are
env-driven — none of them secret. The JWT is never env-sourced; it's always
typed into the UI at runtime, per the no-server-side-persistence rule below.

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
  tokens live in `src/app/globals.css` under `@theme inline` as
  `--color-*` variables (`brand`, `accent`, `ink`, `ink-muted`, `canvas`,
  `surface`, `border`, `console-bg`, `console-text`, `success`, `danger`,
  etc.), which Tailwind turns into utilities automatically (`bg-brand`,
  `text-ink-muted`, ...). Add new design tokens there, not as arbitrary
  `[#hex]` values in components.
- Fonts are Geist Sans/Mono via `next/font/google`, wired in `layout.tsx`.
- Client components are explicit (`"use client"`); keep new presentational
  pieces as plain server components unless they need state/handlers.
- The JWT is **never persisted server-side** — it lives in React state and
  `sessionStorage` (client only) and is forwarded per-request. Don't add
  logging of the `jwt`/`Authorization` values anywhere in `route.ts`.
- This app has no test suite; verify changes with `npm run dev` + a real
  (or at least well-formed) JWT and harness ARN, and watch the "Raw event
  stream" panel — it's the fastest way to see whether a protocol-level
  change actually worked.
