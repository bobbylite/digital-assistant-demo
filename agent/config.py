"""Environment configuration for the custom AgentCore agent.

Mirrors the naming already used by the Next.js app's own env vars
(AGENT_CLIENT_ID / AGENT_CLIENT_SECRET / OIDC_DISCOVERY_URL /
AGENT_EXCHANGE_SCOPE) where the concept is the same PingOne agent identity —
see the root project's CLAUDE.md "Agent authentication" section. This is a
separate process with its own .env, so the values have to be duplicated
there; only the names are kept identical for copy/paste friendliness.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class McpServerConfig:
    name: str
    url: str
    # Identifier used both as the RFC 8693 token-exchange `resource` and as
    # half of the authorization "resource" string sent to the PDP
    # (resourceId:toolName) — see authz.py / mcp_tools.py.
    resource_id: str


@dataclass(frozen=True)
class Settings:
    port: int
    bedrock_model_id: str
    mcp_servers: list[McpServerConfig] = field(default_factory=list)

    authz_decision_url: str | None = None
    authz_timeout_ms: int = 3000

    oidc_discovery_url: str | None = None
    agent_client_id: str | None = None
    agent_client_secret: str | None = None
    agent_scope: str = "agent"
    agent_exchange_scope: str = "agent:exchange"

    @property
    def authz_configured(self) -> bool:
        return bool(self.authz_decision_url)

    @property
    def token_exchange_configured(self) -> bool:
        return bool(self.oidc_discovery_url and self.agent_client_id and self.agent_client_secret)


def _parse_mcp_servers(raw: str | None) -> list[McpServerConfig]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"MCP_SERVERS_CONFIG is not valid JSON: {exc}") from exc

    if not isinstance(parsed, list):
        raise ValueError("MCP_SERVERS_CONFIG must be a JSON array")

    servers: list[McpServerConfig] = []
    for entry in parsed:
        if not isinstance(entry, dict) or not entry.get("name") or not entry.get("url"):
            raise ValueError(f"Invalid MCP_SERVERS_CONFIG entry (needs name + url): {entry!r}")
        servers.append(
            McpServerConfig(
                name=entry["name"],
                url=entry["url"],
                resource_id=entry.get("resourceId", entry["name"]),
            )
        )
    return servers


def load_settings() -> Settings:
    return Settings(
        port=int(os.environ.get("PORT", "8080")),
        bedrock_model_id=os.environ.get(
            "BEDROCK_MODEL_ID", "global.anthropic.claude-haiku-4-5-20251001-v1:0"
        ),
        mcp_servers=_parse_mcp_servers(os.environ.get("MCP_SERVERS_CONFIG")),
        authz_decision_url=os.environ.get("AUTHZ_DECISION_URL") or None,
        authz_timeout_ms=int(os.environ.get("AUTHZ_TIMEOUT_MS", "3000")),
        oidc_discovery_url=os.environ.get("OIDC_DISCOVERY_URL") or None,
        agent_client_id=os.environ.get("AGENT_CLIENT_ID") or None,
        agent_client_secret=os.environ.get("AGENT_CLIENT_SECRET") or None,
        agent_scope=os.environ.get("AGENT_SCOPE", "agent"),
        agent_exchange_scope=os.environ.get("AGENT_EXCHANGE_SCOPE", "agent:exchange"),
    )
