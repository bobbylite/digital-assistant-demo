"""Fine-grained MCP tool access control via a PingOne-Authorize-shaped PDP.

No real decisioning endpoint exists yet (per project decision — see the plan
this was built from), so the request/response contract here is a documented
best guess, easy to adjust once a real PingOne Authorize environment (or
equivalent PDP) is available:

  POST {AUTHZ_DECISION_URL}
  {
    "subject": {"sub": "<end-user sub claim>"},
    "actor": {"client_id": "<this agent's client_id claim>"},
    "resource": "<mcpServerResourceId>:<toolName>",
    "action": "invoke"
  }

  -> {"decision": "PERMIT"} | {"decision": "DENY"}

Fail-closed (deny) on any error, timeout, or non-2xx response — this is an
access-control gate, not a best-effort hint. Fail-open (skip the check
entirely, log a warning) only when AUTHZ_DECISION_URL is unset, matching
this project's "unconfigured means the feature is off" convention
(see isOidcConfigured() in the Next.js app).
"""

from __future__ import annotations

import logging

import requests

from config import Settings

logger = logging.getLogger("agent.authz")


class PolicyDecisionClient:
    def __init__(self, settings: Settings):
        self._settings = settings

    def authorize(self, *, subject_sub: str | None, actor_client_id: str | None, resource: str, action: str = "invoke") -> bool:
        if not self._settings.authz_configured:
            logger.warning(
                "AUTHZ_DECISION_URL not configured — skipping authorization check for resource=%s (fail-open, dev only)",
                resource,
            )
            return True

        try:
            resp = requests.post(
                self._settings.authz_decision_url,  # type: ignore[arg-type]
                json={
                    "subject": {"sub": subject_sub},
                    "actor": {"client_id": actor_client_id},
                    "resource": resource,
                    "action": action,
                },
                timeout=self._settings.authz_timeout_ms / 1000,
            )
        except requests.RequestException as exc:
            logger.error("Authorization decision request failed for resource=%s: %s (fail-closed: deny)", resource, exc)
            return False

        if not resp.ok:
            logger.error(
                "Authorization decision endpoint returned %s for resource=%s (fail-closed: deny)",
                resp.status_code,
                resource,
            )
            return False

        try:
            decision = resp.json().get("decision")
        except ValueError:
            logger.error("Authorization decision response was not JSON for resource=%s (fail-closed: deny)", resource)
            return False

        permitted = decision == "PERMIT"
        if not permitted:
            logger.info("Authorization decision DENY for resource=%s (decision=%r)", resource, decision)
        return permitted
