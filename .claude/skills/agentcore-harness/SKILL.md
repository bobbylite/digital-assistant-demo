---
name: agentcore-harness
description: Reference for Bedrock AgentCore harness invocation details (endpoint shape, auth, event-stream framing) needed when touching src/app/api/invoke/route.ts or extending this app's AWS integration.
---

# Bedrock AgentCore harness invocation reference

Background knowledge for working on this app's AWS integration. Load this
before modifying `src/app/api/invoke/route.ts` or debugging a failed
invocation — the failure modes here are protocol-shaped, not app-bug-shaped,
and are easy to misdiagnose without this context.

## Harness vs. Runtime

A **harness** is a managed, config-only agent (Strands-based orchestration
loop) that AWS runs inside an auto-created **Runtime** it manages for you.
That Runtime ARN (`arn:...:runtime/harness_<name>-<suffix>`) is *not*
directly invokable — calling `InvokeAgentRuntime` on it returns:

```json
{"message": "The agent runtime ... is managed by a harness and cannot be invoked directly. Use the InvokeHarness API with the relevant harness ID instead."}
```

Use the harness's own ARN instead: `arn:aws:bedrock-agentcore:{region}:{account}:harness/{name}-{suffix}`.
Get it via `aws bedrock-agentcore-control list-harnesses` /
`get-harness` if you only have the runtime ARN — the console tends to
surface the runtime ARN, not the harness ARN.

## Request shape (`InvokeHarness`)

```
POST https://bedrock-agentcore.{region}.amazonaws.com/harnesses/invoke?harnessArn={URL_ENCODED_HARNESS_ARN}&qualifier=DEFAULT
Authorization: Bearer {jwt}          # only if the harness's inbound auth is JWT/OAuth, not IAM SigV4
Content-Type: application/json
X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: {33-100 char session id, [a-zA-Z0-9][a-zA-Z0-9-_]*}

{
  "messages": [
    { "role": "user", "content": [ { "text": "..." } ] }
  ]
}
```

Notes that don't match the plain `InvokeAgentRuntime` API:

- The ARN is a **query param** here (`harnessArn=`), not URL-encoded into
  the path like `InvokeAgentRuntime`'s `/runtimes/{arn}/invocations`.
- `messages` (chat-turn array) replaces the free-form `payload` blob —
  harness invocations are inherently chat-shaped.
- Missing the session-id header produces a `ValidationException` that
  names the field `runtimeSessionId`, which reads like a body-field error
  — it isn't; it's the header being absent or malformed.

## Response shape: AWS event-stream binary framing

The response is always `application/vnd.amazon.eventstream`, regardless of
`Accept` header — raw bytes, not text/JSON, and not optional. Each frame:

```
[4-byte total length][4-byte header length][4-byte prelude CRC]
[headers: :event-type / :content-type / :message-type][JSON payload][4-byte message CRC]
```

**The header names are colon-prefixed** (`:event-type`, `:message-type`,
`:content-type`) — confirmed against AWS's own smithy SDK source
(`@smithy/core/.../EventStreamSerde.js` encodes exactly these keys). Looking
them up without the leading colon (`decoded.headers["event-type"]`) silently
returns `undefined` for every real frame — no error, no exception, `decode()`
succeeds, the JSON payload comes through fine, just the type comes back
`undefined` and gets defaulted to `"unknown"`. Symptom: the raw event
console shows every event as `unknown` (except any event type your own code
synthesizes directly, like a literal `send("done", {})`, which isn't
header-derived and so isn't affected) and the chat UI never updates because
`type === "contentBlockDelta"` never matches — it looks exactly like a
stuck/infinite "typing" indicator, not like a decoding bug. `route.ts`'s
`headerValue()` calls check `:event-type`/`:message-type` first; keep it
that way if you touch this code.

Reading this as plain text (e.g. pasting a raw response into Postman) shows
mostly binary noise with JSON fragments floating in it — that's expected,
not a bug. Decode it with `@smithy/eventstream-codec` (already a dependency
here); see `route.ts` for the buffering + decode loop, which:

1. Accumulates bytes from the upstream reader until a full frame's
   `totalLength` is available (frames can split across TCP/stream chunks).
2. Decodes each complete frame with `EventStreamCodec.decode()`.
3. Re-emits it to the browser as hand-rolled SSE (`event: {type}\ndata: {json}\n\n`)
   over a same-origin `ReadableStream` response — plain `EventSource` on the
   client can't be used because it can't POST or set the `Authorization`
   header, so the client-side parsing in `AgentConsole.tsx` is also manual.

Event types you'll see, in order, for a normal turn: `messageStart` →
repeated `contentBlockDelta` (the actual streamed text, in `delta.text`) →
`contentBlockStop` → `messageStop` → `metadata` (latency + token usage).
`message-type: exception` frames (surfaced here as `agent-error`) carry
`runtimeClientError` / `validationException` / `internalServerException`
bodies — check `eventType` on those to tell them apart.

## Auth

A harness/runtime supports **either** IAM SigV4 **or** JWT/OAuth inbound
auth, never both. This app only supports the JWT path (bearer token typed
into the UI) since that's what a browser-originated demo needs — SigV4
would require AWS credentials live in the browser or a signing step, which
is out of scope here. If a harness was created with SigV4-only auth, this
app cannot invoke it; that's a harness configuration issue, not something
fixable in `route.ts`.
