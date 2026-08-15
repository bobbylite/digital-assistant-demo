"""MCP tool wiring: per-invocation connections + fine-grained authorization gate.

Verified against the installed strands-agents/mcp package sources (not guessed):
`MCPClient(transport_callable)` wraps `mcp_tool.list_tools_sync()` results as
`MCPAgentTool` instances (already `strands.types.tools.AgentTool` subclasses,
directly usable in `Agent(tools=[...])`). There is no documented or discoverable
pre/post tool-call hook on MCPClient, so per-call authorization is implemented
here as our own `AgentTool` wrapper delegating to the real one.

Design decision (a refinement of the original plan while implementing this):
MCP connections are opened fresh for *each agent invocation* (one turn), scoped
to that invocation's own inbound end-user token, and closed when the turn ends
— not held open for the life of the process. Reusing one connection across
different users' turns would mean an MCP server request could go out carrying
a stale or wrong user's downstream token; per-invocation connections avoid
that entirely. The authorization (PDP) check still runs on every single tool
call within a turn. The one remaining limitation: streamable-HTTP auth
headers are set once when the connection opens, not renegotiated per tool
call — so multiple tool calls to the *same* server *within one turn* share one
downstream token. See README.md.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass

from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp import MCPClient
from strands.types._events import ToolResultEvent
from strands.types.tools import AgentTool, ToolGenerator, ToolUse

from authz import PolicyDecisionClient
from config import Settings
from token_exchange import TokenExchangeClient

logger = logging.getLogger("agent.mcp_tools")


@dataclass(frozen=True)
class RequestIdentity:
    """Identity of the caller for the current invocation, read from the
    already-validated inbound JWT (see main.py's `_decode_identity`)."""

    sub: str | None
    client_id: str | None
    raw_token: str | None


class _AuthorizedTool(AgentTool):
    """Wraps a real MCPAgentTool with a per-call PDP authorization check."""

    def __init__(self, inner: AgentTool, resource_id: str, authz: PolicyDecisionClient, identity: RequestIdentity):
        super().__init__()
        self._inner = inner
        self._resource_id = resource_id
        self._authz = authz
        self._identity = identity

    @property
    def tool_name(self) -> str:
        return self._inner.tool_name

    @property
    def tool_spec(self):
        return self._inner.tool_spec

    @property
    def tool_type(self) -> str:
        return self._inner.tool_type

    async def stream(self, tool_use: ToolUse, invocation_state: dict, **kwargs) -> ToolGenerator:
        resource = f"{self._resource_id}:{self.tool_name}"
        permitted = self._authz.authorize(
            subject_sub=self._identity.sub,
            actor_client_id=self._identity.client_id,
            resource=resource,
        )
        if not permitted:
            logger.info(
                "authz DENY tool_use_id=%s tool=%s resource=%s sub=%s",
                tool_use["toolUseId"],
                self.tool_name,
                resource,
                self._identity.sub,
            )
            yield ToolResultEvent(
                {
                    "toolUseId": tool_use["toolUseId"],
                    "status": "error",
                    "content": [
                        {
                            "text": (
                                f"Access denied: not authorized to invoke '{self.tool_name}' "
                                f"on '{self._resource_id}'."
                            )
                        }
                    ],
                }
            )
            return

        async for event in self._inner.stream(tool_use, invocation_state, **kwargs):
            yield event


async def _stop_client(client: MCPClient) -> None:
    try:
        client.stop(None, None, None)
    except Exception:
        logger.exception("error stopping MCP client")


async def connect_mcp_tools(
    settings: Settings,
    identity: RequestIdentity,
    authz: PolicyDecisionClient,
    token_exchange: TokenExchangeClient | None,
    stack: AsyncExitStack,
) -> list[AgentTool]:
    """Connect every configured MCP server for this single invocation and return
    authorization-gated tools. Connections are registered on `stack` so the
    caller closes them all when the turn finishes (see main.py)."""
    tools: list[AgentTool] = []

    for server in settings.mcp_servers:
        headers: dict[str, str] = {}
        if token_exchange is not None and identity.raw_token:
            try:
                token = token_exchange.exchange_for_resource(identity.raw_token, server.resource_id)
                headers = {"Authorization": f"Bearer {token}"}
            except Exception:
                logger.exception(
                    "server=%s | token exchange failed, connecting without a downstream token", server.name
                )
        elif identity.raw_token:
            # No token-exchange configured — fall back to forwarding the inbound
            # token as-is, same "degrade, don't block" spirit as elsewhere here.
            headers = {"Authorization": f"Bearer {identity.raw_token}"}

        transport_callable = _build_transport(server.url, headers)
        client = MCPClient(transport_callable, application_name="agentcore-custom-agent")

        try:
            client.start()
        except Exception:
            logger.exception("server=%s | failed to connect, skipping its tools for this turn", server.name)
            continue

        # Registered even though start() succeeded, so a later failure in this
        # loop still closes every connection opened so far.
        stack.push_async_callback(_stop_client, client)

        try:
            server_tools = client.list_tools_sync()
        except Exception:
            logger.exception("server=%s | failed to list tools, skipping", server.name)
            continue

        for tool in server_tools:
            tools.append(_AuthorizedTool(tool, server.resource_id, authz, identity))

    return tools


def _build_transport(url: str, headers: dict[str, str]) -> Callable[[], Awaitable]:
    def _factory():
        return streamablehttp_client(url=url, headers=headers)

    return _factory
