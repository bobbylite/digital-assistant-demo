"""RFC 8693 token exchange, mirroring src/app/api/auth/agent-token/route.ts.

Two-step flow, same as the Next.js app:
  1. Client Credentials Grant — this agent authenticates as itself (its own
     PingOne application, AGENT_CLIENT_ID/AGENT_CLIENT_SECRET) to get an
     actor_token. No user involved.
  2. Token Exchange — that actor_token, plus the end user's own inbound
     access token as subject_token, is exchanged for a resource-scoped
     delegated token used to call one specific downstream MCP server.

Both steps hit the same PingOne token endpoint (discovered from
OIDC_DISCOVERY_URL) with HTTP Basic client auth — PingOne requires
client_secret_basic, not the client_secret_post many OAuth libraries default
to; see src/lib/oidc.ts's documented gotcha about this same requirement.

Actor tokens and per-resource exchanged tokens are cached in-memory and
refreshed lazily (30s before expiry), not re-minted on every call — see
agent/README.md's "known limitation" section for why per-call rotation
isn't attempted.
"""

from __future__ import annotations

import hashlib
import time

import requests

from config import Settings

_EXPIRY_SAFETY_MARGIN_S = 30
_DEFAULT_EXPIRES_IN_S = 300


class TokenExchangeError(RuntimeError):
    pass


class TokenExchangeClient:
    def __init__(self, settings: Settings):
        if not settings.token_exchange_configured:
            raise TokenExchangeError(
                "Token exchange is not configured — OIDC_DISCOVERY_URL / "
                "AGENT_CLIENT_ID / AGENT_CLIENT_SECRET must all be set."
            )
        self._settings = settings
        self._token_endpoint: str | None = None
        self._actor_token: str | None = None
        self._actor_token_expiry: float = 0.0
        # resource -> (access_token, expiry_epoch_s)
        self._resource_tokens: dict[str, tuple[str, float]] = {}

    def _discover_token_endpoint(self) -> str:
        if self._token_endpoint:
            return self._token_endpoint
        resp = requests.get(self._settings.oidc_discovery_url, timeout=5)
        resp.raise_for_status()
        endpoint = resp.json().get("token_endpoint")
        if not endpoint:
            raise TokenExchangeError("OIDC discovery document has no token_endpoint")
        self._token_endpoint = endpoint
        return endpoint

    def _client_auth(self) -> tuple[str, str]:
        return (self._settings.agent_client_id, self._settings.agent_client_secret)  # type: ignore[return-value]

    def _get_actor_token(self) -> str:
        now = time.time()
        if self._actor_token and now < self._actor_token_expiry - _EXPIRY_SAFETY_MARGIN_S:
            return self._actor_token

        endpoint = self._discover_token_endpoint()
        resp = requests.post(
            endpoint,
            data={"grant_type": "client_credentials", "scope": self._settings.agent_scope},
            auth=self._client_auth(),
            timeout=5,
        )
        if not resp.ok:
            raise TokenExchangeError(f"Client credentials grant failed: {resp.status_code} {resp.text}")

        payload = resp.json()
        self._actor_token = payload["access_token"]
        self._actor_token_expiry = now + payload.get("expires_in", _DEFAULT_EXPIRES_IN_S)
        return self._actor_token

    def exchange_for_resource(self, subject_token: str, resource: str) -> str:
        """Mint (or reuse a cached) access token scoped to a specific MCP resource.

        Cached per (subject, resource) — keyed off a hash of the subject_token,
        not the resource alone, so two different end users requesting the same
        resource never share a cached downstream token.
        """
        now = time.time()
        cache_key = f"{hashlib.sha256(subject_token.encode()).hexdigest()[:16]}:{resource}"
        cached = self._resource_tokens.get(cache_key)
        if cached and now < cached[1] - _EXPIRY_SAFETY_MARGIN_S:
            return cached[0]

        actor_token = self._get_actor_token()
        endpoint = self._discover_token_endpoint()
        resp = requests.post(
            endpoint,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                "subject_token": subject_token,
                "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "actor_token": actor_token,
                "actor_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "resource": resource,
                "scope": self._settings.agent_exchange_scope,
            },
            auth=self._client_auth(),
            timeout=5,
        )
        if not resp.ok:
            raise TokenExchangeError(f"Token exchange failed for resource {resource!r}: {resp.status_code} {resp.text}")

        payload = resp.json()
        token = payload["access_token"]
        expiry = now + payload.get("expires_in", _DEFAULT_EXPIRES_IN_S)
        self._resource_tokens[cache_key] = (token, expiry)
        return token
