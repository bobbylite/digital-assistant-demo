#!/usr/bin/env bash
# Bootstraps (first run only) and starts the local agent for `npm run dev`.
set -euo pipefail
cd "$(dirname "$0")/.."   # agent/

if [ ! -d .venv ]; then
  echo "[agent] first run — creating .venv and installing requirements..."
  python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install -q -r requirements.txt
else
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

exec python main.py
