---
name: run
description: Launch the AgentCore Console dev server and verify it's serving before handing back to the user.
---

# Running AgentCore Console

This is a Next.js 16 App Router project (Turbopack dev server). No env vars
are required to boot — connection details (JWT, region, harness ARN,
qualifier) are entered in the UI at runtime, not read from `.env`.

## Steps

1. Install deps if `node_modules` is missing or `package.json` changed:
   ```bash
   npm install
   ```
2. Start the dev server in the background (it does not exit on its own):
   ```bash
   npm run dev
   ```
3. Confirm it's actually serving before telling the user it's ready:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
   ```
   Expect `200`. If the port is already taken, Next.js will pick the next
   free port (3001, ...) and print it in the dev server log — check the log
   output rather than assuming 3000.
4. Open http://localhost:3000 in a browser (or tell the user to).

## Smoke-testing the API route without a browser

`/api/invoke` requires `jwt`, `region`, `harnessArn`, `sessionId`, and a
non-empty `messages` array — hitting it with an empty body is a fast way to
confirm the route is wired up without needing real AWS credentials:

```bash
curl -s -X POST http://localhost:3000/api/invoke \
  -H "Content-Type: application/json" -d '{}'
# expect: {"error":"jwt, region, harnessArn, sessionId, and a non-empty messages array are required."}
```

A real end-to-end test needs a live JWT and harness ARN, which the agent
running this skill won't have — leave that verification to the user unless
they've supplied both in the conversation.

## Shutting down

If you started the dev server yourself (e.g. for a smoke test) rather than
leaving it running for the user, kill it before finishing:

```bash
lsof -ti:3000 | xargs -r kill
```
