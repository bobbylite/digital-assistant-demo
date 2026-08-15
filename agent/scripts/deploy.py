#!/usr/bin/env python3
"""Upload deployment_package.zip to S3 and create/update the AgentCore Runtime.

Idempotent: looks up an existing runtime by name first (ListAgentRuntimes),
updates it if found, creates it if not -- never silently duplicates a
runtime. This script does NOT create the S3 bucket or the IAM execution
role; both are prerequisites (see ../README.md).

Every parameter name and shape here was verified against the actual
installed boto3 bedrock-agentcore-control service model (introspected via
`client.meta.service_model`), not guessed from documentation prose.

Sets authorizerConfiguration.customJWTAuthorizer from OIDC_DISCOVERY_URL /
AGENT_CLIENT_ID in the environment -- the same PingOne discovery URL and
agent client ID the Next.js app already uses for its own RFC 8693 token
exchange (see the root project's CLAUDE.md "Agent authentication" section).
This is what lets that exact exchanged token, which already satisfies the
standard harness today, satisfy this custom runtime too, with no changes on
the Next.js/OIDC side. If those env vars aren't set, the runtime deploys
with no JWT authorizer (falls back to AWS's default IAM SigV4 auth) --
usable from the AWS SDK/CLI directly, but not from the Next.js app's
bearer-JWT invocation until redeployed with them set.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import boto3

# Forwarded into the deployed runtime's own environment (its only source of
# config once deployed -- there's no separate settings mechanism). Mirrors
# what config.py reads from os.environ.
_FORWARDED_ENV_VARS = [
    "BEDROCK_MODEL_ID",
    "MCP_SERVERS_CONFIG",
    "AUTHZ_DECISION_URL",
    "AUTHZ_TIMEOUT_MS",
    "OIDC_DISCOVERY_URL",
    "AGENT_CLIENT_ID",
    "AGENT_CLIENT_SECRET",
    "AGENT_SCOPE",
    "AGENT_EXCHANGE_SCOPE",
]

_PYTHON_RUNTIMES = ["PYTHON_3_10", "PYTHON_3_11", "PYTHON_3_12", "PYTHON_3_13", "PYTHON_3_14"]


def _find_existing_runtime_id(control, name: str) -> str | None:
    next_token = None
    while True:
        kwargs = {"nextToken": next_token} if next_token else {}
        resp = control.list_agent_runtimes(**kwargs)
        for runtime in resp.get("agentRuntimes", []):
            if runtime["agentRuntimeName"] == name:
                return runtime["agentRuntimeId"]
        next_token = resp.get("nextToken")
        if not next_token:
            return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--region", required=True)
    parser.add_argument("--role-arn", required=True, help="Pre-existing execution role ARN for the runtime.")
    parser.add_argument("--bucket", required=True, help="Pre-existing S3 bucket for the deployment artifact.")
    parser.add_argument("--name", required=True, help="AgentCore Runtime name.")
    parser.add_argument(
        "--zip-path",
        default=str(Path(__file__).resolve().parent.parent / "deployment_package.zip"),
        help="Defaults to ../deployment_package.zip (the output of package.sh).",
    )
    parser.add_argument("--python-runtime", default="PYTHON_3_13", choices=_PYTHON_RUNTIMES)
    parser.add_argument("--dry-run", action="store_true", help="Print what would happen without calling AWS.")
    args = parser.parse_args()

    zip_path = Path(args.zip_path)
    if not zip_path.is_file():
        print(f"error: {zip_path} does not exist -- run scripts/package.sh first.", file=sys.stderr)
        return 1

    s3_prefix = f"{args.name}/deployment_package.zip"

    authorizer_configuration = None
    discovery_url = os.environ.get("OIDC_DISCOVERY_URL")
    client_id = os.environ.get("AGENT_CLIENT_ID")
    if discovery_url and client_id:
        authorizer_configuration = {
            "customJWTAuthorizer": {"discoveryUrl": discovery_url, "allowedClients": [client_id]}
        }
    else:
        print(
            "warning: OIDC_DISCOVERY_URL / AGENT_CLIENT_ID not set in the environment -- deploying with "
            "no JWT authorizer (falls back to IAM SigV4). The Next.js app's bearer-JWT invocation won't "
            "work against this runtime until you redeploy with those set.",
            file=sys.stderr,
        )

    environment_variables = {key: os.environ[key] for key in _FORWARDED_ENV_VARS if os.environ.get(key)}

    print(f"Zip:        {zip_path} ({zip_path.stat().st_size / 1024 / 1024:.1f} MB)")
    print(f"Region:     {args.region}")
    print(f"S3 target:  s3://{args.bucket}/{s3_prefix}")
    print(f"Role:       {args.role_arn}")
    print(f"Name:       {args.name}")
    print(f"Env vars:   {sorted(environment_variables.keys()) or '(none)'}")
    print(f"Authorizer: {'customJWTAuthorizer -> ' + discovery_url if authorizer_configuration else 'none (IAM SigV4)'}")

    if args.dry_run:
        print("\n--dry-run: not calling AWS.")
        return 0

    sts = boto3.client("sts", region_name=args.region)
    account_id = sts.get_caller_identity()["Account"]

    s3 = boto3.client("s3", region_name=args.region)
    print(f"\nUploading {zip_path.name} to s3://{args.bucket}/{s3_prefix} ...")
    s3.upload_file(str(zip_path), args.bucket, s3_prefix, ExtraArgs={"ExpectedBucketOwner": account_id})

    control = boto3.client("bedrock-agentcore-control", region_name=args.region)
    artifact = {
        "codeConfiguration": {
            "code": {"s3": {"bucket": args.bucket, "prefix": s3_prefix}},
            "runtime": args.python_runtime,
            "entryPoint": ["main.py"],
        }
    }

    common_kwargs: dict = {
        "agentRuntimeArtifact": artifact,
        "roleArn": args.role_arn,
        "networkConfiguration": {"networkMode": "PUBLIC"},
        "environmentVariables": environment_variables,
    }
    if authorizer_configuration:
        common_kwargs["authorizerConfiguration"] = authorizer_configuration

    existing_id = _find_existing_runtime_id(control, args.name)
    if existing_id:
        print(f"\nExisting runtime found (id={existing_id}) -- updating...")
        response = control.update_agent_runtime(agentRuntimeId=existing_id, **common_kwargs)
    else:
        print("\nNo existing runtime with this name -- creating...")
        response = control.create_agent_runtime(agentRuntimeName=args.name, **common_kwargs)

    print(f"\nagentRuntimeArn: {response['agentRuntimeArn']}")
    print(f"status:          {response['status']}")
    print("\nPaste the ARN above into the Next.js app's Settings panel as the Agent Runtime ARN.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
