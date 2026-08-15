# Custom AgentCore agent

A custom `bedrock_agentcore.BedrockAgentCoreApp` + `strands.Agent`, replacing
the standard AWS-managed harness the parent Next.js app used to call. See
the root project's `CLAUDE.md` for how this fits into the overall app, and
the plan this was built from for the full design rationale.

Unlike the AWS sample's bare `{"prompt": "..."}` contract, this agent accepts
the same `{"messages": [...]}` shape the Next.js app already sends to the
harness, and streams back the same `messageStart` / `contentBlockDelta` /
`contentBlockStop` / `messageStop` / `metadata` event vocabulary — so the
existing chat UI needs no changes, only the Next.js proxy route's upstream
call does. See `main.py` for exactly how each Strands `stream_async()` event
is translated into that shape.

## What it does beyond the standard harness

1. Reads the inbound bearer JWT (already signature/issuer/audience-validated
   by AgentCore's own JWT authorizer before this code ever runs) to know
   which end user and which agent identity are acting.
2. Calls configurable MCP tool servers (`MCP_SERVERS_CONFIG`).
3. Before every single MCP tool call, asks a PingOne-Authorize-shaped
   decisioning endpoint whether this (subject, actor, resource) triple is
   permitted — see `authz.py`. **No real decisioning endpoint exists yet** —
   the contract there is documented and meant to be adjusted once one does.
   Unconfigured (`AUTHZ_DECISION_URL` unset) means the check is skipped
   entirely (fail-open, logged) so local dev without a PDP isn't blocked;
   configured-but-erroring fails closed (deny).
4. Token-exchanges (RFC 8693, same two-step client-credentials-then-exchange
   flow as the Next.js app's `/api/auth/agent-token` route — see `token_exchange.py`)
   to get a resource-scoped downstream token per MCP server.

## Known limitation: per-tool-call token freshness

MCP connections (and the resource-scoped downstream token used to
authenticate to them) are opened **fresh for each agent invocation** — one
per conversation turn, scoped to that turn's own inbound end-user token —
not held open for the life of the process. This was a deliberate refinement
made while implementing (see `mcp_tools.py`'s module docstring): reusing one
long-lived connection across different users' turns would risk one user's
MCP request going out carrying a different user's downstream token.

The PDP authorization check still runs on **every single tool call** — that's
the actual fine-grained access-control requirement, and it's unaffected by
this. What's still true: MCP's streamable-HTTP transport sets its
`Authorization` header once, when the connection opens — not per call — so
multiple tool calls to the *same* server *within one turn* share one
downstream token. Revisit this once a real MCP server's auth requirements
are known; the fix, if needed, is reconnecting between tool calls within a
turn, not just between turns.

## Running locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Needs real AWS credentials with Bedrock model access (same account/region
# as wherever this eventually gets deployed) — the standard boto3 credential
# chain (env vars, ~/.aws/credentials, SSO, etc.) is used automatically.
cp .env.example .env
set -a; source .env; set +a

python main.py   # serves on :8080
```

In another terminal:

```bash
curl http://localhost:8080/ping
# {"status":"Healthy","time_of_last_update":...}

curl -N -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -H "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: local-test-session-0123456789" \
  -d '{"messages": [{"role": "user", "content": [{"text": "hello"}]}]}'
```

You should see a stream of `data: {"type": "messageStart", ...}` /
`contentBlockDelta` / ... / `metadata` lines — this exact request/response
shape is what the parent app's "Local Agent" runtime-target setting (see the
root project's Settings panel) points at.

To point the Next.js app at this local agent instead of AWS: run `npm run dev`
in the repo root, open Settings, switch the runtime target to "Local Agent",
and leave the URL at the default `http://localhost:8080` (or wherever `PORT`
above is set).

## Deploying to AWS

Two steps, matching AWS's documented direct-code (.zip) deployment path —
not a Docker/container deployment:

`scripts/deploy.py` needs `boto3` installed locally (`pip install boto3`) —
deliberately not in `requirements.txt`, since that file is what gets zipped
into the deployed agent itself, and the deployed agent never calls AWS's
control-plane API on its own behalf.

```bash
# 1. Build deployment_package.zip (ARM64 dependencies + main.py + the other
#    modules in this directory).
./scripts/package.sh

# 2. Upload it to S3 and create (or update) the AgentCore Runtime.
python scripts/deploy.py \
  --region us-east-2 \
  --role-arn arn:aws:iam::<account-id>:role/<execution-role> \
  --bucket <s3-bucket-for-deployment-artifacts> \
  --name my-custom-agent
```

`scripts/deploy.py` prints the resulting `agentRuntimeArn` — paste that into
the Next.js app's Settings panel as the "Agent Runtime ARN" and switch the
runtime target to "Agent Runtime" to start using it.

**Prerequisites this script does not create for you:**
- An S3 bucket for the deployment artifact.
- An IAM execution role for the runtime (needs `bedrock:InvokeModel` on
  whatever `BEDROCK_MODEL_ID` you're using, plus standard CloudWatch Logs
  permissions — see AWS's
  [AgentCore Runtime permissions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html)
  doc).
- Model access enabled for `BEDROCK_MODEL_ID` in the Bedrock console, in the
  target region.

`deploy.py` also sets `authorizerConfiguration.customJWTAuthorizer` from
`OIDC_DISCOVERY_URL`/`AGENT_CLIENT_ID` (same PingOne discovery URL and agent
client ID the Next.js app already uses) — this is what makes the exact same
RFC 8693 exchanged token that already satisfies the harness today satisfy
this custom runtime too, with zero changes needed on the Next.js OIDC/token-
exchange side.

Any env vars the deployed agent needs at runtime (`MCP_SERVERS_CONFIG`,
`AUTHZ_DECISION_URL`, `AGENT_CLIENT_SECRET`, etc.) are passed to
`create_agent_runtime`/`update_agent_runtime`'s `environmentVariables` — see
`scripts/deploy.py`; it reads them from your local `.env` the same way
`main.py` does, so keep that file up to date before deploying.
