#!/usr/bin/env bash
# Build deployment_package.zip for AWS's direct-code (.zip) deployment path
# for AgentCore Runtime -- confirmed step-by-step against AWS's own devguide
# (uv pip install --python-platform aarch64-manylinux2014, then zip). Not a
# Docker/container deployment.
set -euo pipefail

cd "$(dirname "$0")/.."   # agent/ directory

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv is required (https://docs.astral.sh/uv/getting-started/installation/) -- not found on PATH." >&2
  exit 1
fi

PYTHON_VERSION="${PYTHON_VERSION:-3.13}"
BUILD_DIR="deployment_package"
ZIP_PATH="deployment_package.zip"

rm -rf "$BUILD_DIR" "$ZIP_PATH"
mkdir -p "$BUILD_DIR"

echo "Installing ARM64 (aarch64-manylinux2014) dependencies for Python $PYTHON_VERSION..."
uv pip install \
  --python-platform aarch64-manylinux2014 \
  --python-version "$PYTHON_VERSION" \
  --target="$BUILD_DIR" \
  --only-binary=:all: \
  -r requirements.txt

# AWS explicitly recommends against shipping __pycache__: bytecode compiled
# on this build machine's architecture/OS may not be compatible with the
# ARM64 Linux runtime it actually runs on.
find "$BUILD_DIR" -type d -name "__pycache__" -prune -exec rm -rf {} +

echo "Packaging dependencies into $ZIP_PATH..."
(cd "$BUILD_DIR" && zip -rq "../$ZIP_PATH" .)

echo "Adding agent source files..."
zip -q "$ZIP_PATH" main.py config.py authz.py token_exchange.py mcp_tools.py

SIZE_BYTES=$(stat -f%z "$ZIP_PATH" 2>/dev/null || stat -c%s "$ZIP_PATH")
SIZE_MB=$((SIZE_BYTES / 1024 / 1024))
echo "Built $ZIP_PATH (${SIZE_MB} MB)."

LIMIT_BYTES=$((250 * 1024 * 1024))
if [ "$SIZE_BYTES" -gt "$LIMIT_BYTES" ]; then
  echo "WARNING: $ZIP_PATH exceeds AgentCore Runtime's 250MB zipped deployment package limit." >&2
fi

echo "Next: python scripts/deploy.py --region <region> --role-arn <arn> --bucket <bucket> --name <name>"
