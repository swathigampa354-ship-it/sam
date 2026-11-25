#!/usr/bin/env bash
# start.sh — Launch SAM (OpenCode) inside GitHub Codespaces.
#
#   ./start.sh            -> interactive TUI (free model via -m)
#   ./start.sh web        -> native OpenCode web UI on 0.0.0.0:$SAM_PORT (PRIVATE port)
#   ./start.sh run "..."  -> one-shot headless content generation
#
# All modes default to a FREE OpenCode model (no API key, no cost).
set -euo pipefail
export PATH="$HOME/.opencode/bin:$PATH"
cd "$(dirname "$0")"

SAM_MODEL="${SAM_MODEL:-opencode/deepseek-v4.1-flash-free}"
PORT="${SAM_PORT:-3000}"
MODE="${1:-${SAM_MODE:-tui}}"

case "$MODE" in
  web)
    # Secure the web UI. Keep the Codespaces forwarded port PRIVATE.
    if [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then
      OPENCODE_SERVER_PASSWORD="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      echo "Generated OPENCODE_SERVER_PASSWORD (save it if you need to reconnect): ${OPENCODE_SERVER_PASSWORD}"
    fi
    export OPENCODE_SERVER_PASSWORD
    echo "==> Starting SAM web UI at 0.0.0.0:${PORT} (model picker shows free opencode/* models)"
    echo "==> In Codespaces, forward port ${PORT} as PRIVATE and open the browser preview."
    echo "==> In the UI, choose a free model such as: ${SAM_MODEL}"
    exec opencode web --hostname 0.0.0.0 --port "$PORT"
    ;;
  run)
    shift
    echo "==> Running SAM (headless): $*"
    exec opencode run "$@" -m "$SAM_MODEL" --auto
    ;;
  tui|*)
    echo "==> Launching SAM TUI (model: ${SAM_MODEL})"
    exec opencode -m "$SAM_MODEL"
    ;;
esac
