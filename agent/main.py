"""Custom AgentCore Runtime agent.

Replaces the standard AWS-managed harness with our own Strands agent so it
can: read the already-validated inbound identity, call configurable MCP
tools behind a fine-grained PingOne-Authorize-shaped PDP check, and
token-exchange (RFC 8693) for a resource-scoped downstream token per MCP
server — see the root project's CLAUDE.md "Agent authentication" section for
the token-exchange flow this mirrors, and README.md in this directory for how
to run and package this agent.

Accepts the same `{"messages": [...]}` shape the Next.js app already sends to
the AWS-managed harness (see src/app/api/invoke/route.ts), not the SDK
sample's bare `{"prompt": ...}` — this is our own contract, chosen so the
existing chat UI needs no changes. Streams back the same event vocabulary
(`messageStart`/`contentBlockDelta`/`contentBlockStop`/`messageStop`/`metadata`)
the harness already produces, translated from Strands' own stream_async()
events — see _translate_event() below for exactly how, verified against the
installed strands-agents source, not guessed.
"""

from __future__ import annotations

import logging
from contextlib import AsyncExitStack
from typing import Any

import jwt
from bedrock_agentcore import BedrockAgentCoreApp
from strands import Agent

from authz import PolicyDecisionClient
from config import Settings, load_settings
from mcp_tools import RequestIdentity, connect_mcp_tools
from token_exchange import TokenExchangeClient, TokenExchangeError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("agent.main")

app = BedrockAgentCoreApp()

_settings: Settings = load_settings()
_authz = PolicyDecisionClient(_settings)
try:
    _token_exchange: TokenExchangeClient | None = TokenExchangeClient(_settings)
except TokenExchangeError as exc:
    logger.warning("Token exchange not configured (%s) — MCP calls will forward the inbound token as-is.", exc)
    _token_exchange = None

# Chunk shapes Strands' stream_async() actually yields (verified against the
# installed strands.types._events.ModelStreamChunkEvent source: each raw
# model chunk is wrapped as {"event": <one of these keys>: {...}}). Anything
# else stream_async() yields (tool-use-delta convenience events, lifecycle
# events like init_event_loop/start, etc.) has no "event" key and is
# intentionally dropped — this list is what actually reaches the browser.
_KNOWN_EVENT_KEYS = ("messageStart", "contentBlockDelta", "contentBlockStop", "messageStop", "metadata")


def _decode_identity(context: Any) -> RequestIdentity:
    """Extract (sub, client_id) from the inbound bearer token.

    AgentCore's own authorizer has already verified signature/issuer/audience/
    client_id before this code ever runs (see the customJWTAuthorizer
    configuration in scripts/deploy.py) — so this intentionally does not
    re-verify the signature, matching AWS's own documented pattern for
    reading claims inside a runtime handler.
    """
    headers = getattr(context, "request_headers", None) or {}
    auth_header = headers.get("Authorization") or headers.get("authorization")
    if not auth_header:
        return RequestIdentity(sub=None, client_id=None, raw_token=None)

    token = auth_header[7:] if auth_header.lower().startswith("bearer ") else auth_header
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
    except jwt.InvalidTokenError:
        logger.warning("Inbound Authorization header was not a decodable JWT")
        return RequestIdentity(sub=None, client_id=None, raw_token=token)

    return RequestIdentity(sub=claims.get("sub"), client_id=claims.get("client_id"), raw_token=token)


def _extract_text(message: dict) -> str:
    parts = []
    for block in message.get("content", []):
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(parts)


def _translate_event(item: Any) -> dict | None:
    """Strands stream_async() item -> this app's flat {"type": ..., ...} shape."""
    if not isinstance(item, dict):
        return None
    event = item.get("event")
    if not isinstance(event, dict):
        return None
    for key in _KNOWN_EVENT_KEYS:
        if key in event:
            value = event[key]
            return {"type": key, **(value if isinstance(value, dict) else {"value": value})}
    return None


@app.entrypoint
async def invoke(payload: dict, context: Any):
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        yield {"type": "agent-error", "message": "payload.messages must be a non-empty array"}
        return

    history, last = messages[:-1], messages[-1]
    prompt_text = _extract_text(last)
    if not prompt_text:
        yield {"type": "agent-error", "message": "the last message has no text content"}
        return

    identity = _decode_identity(context)

    async with AsyncExitStack() as stack:
        try:
            tools = await connect_mcp_tools(_settings, identity, _authz, _token_exchange, stack)
        except Exception:
            logger.exception("failed to connect configured MCP servers — continuing with no tools")
            tools = []

        agent = Agent(model=_settings.bedrock_model_id, messages=history, tools=tools)

        try:
            async for item in agent.stream_async(prompt_text):
                translated = _translate_event(item)
                if translated is not None:
                    yield translated
        except Exception as exc:
            logger.exception("agent turn failed")
            yield {"type": "agent-error", "message": str(exc)}


if __name__ == "__main__":
    app.run()
