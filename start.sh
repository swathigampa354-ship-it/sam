#!/usr/bin/env bash
# start.sh — Launch SAM (OpenCode) inside GitHub Codespaces.
#
#   ./start.sh            -> interactive TUI (free model)
#   ./start.sh web        -> native OpenCode web UI on 0.0.0.0:$SAM_PORT (PRIVATE port)
#   ./start.sh run "..."  -> one-shot headless content generation
#
# All modes default to a verified FREE OpenCode model (no API key, no cost).
set -euo pipefail
export PATH="$HOME/.opencode/bin:$PATH"
cd "$(dirname "$0")"

SAM_MODEL="${SAM_MODEL:-opencode/mimo-v2.6-flash-free}"
PORT="${SAM_PORT:-3000}"
MODE="${1:-${SAM_MODE:-tui}}"

# Override project model with the verified free model while preserving upstream opencode.jsonc.
# If EXA_API_KEY is not set, disable remote Exa MCP so OpenCode never blocks on interactive OAuth.
if [ -n "${EXA_API_KEY:-}" ]; then
  export OPENCODE_CONFIG_CONTENT="{\"model\":\"${SAM_MODEL}\",\"default_agent\":\"seo-guide\"}"
else
  export OPENCODE_CONFIG_CONTENT="{\"model\":\"${SAM_MODEL}\",\"default_agent\":\"seo-guide\",\"mcp\":{\"exa\":{\"type\":\"remote\",\"url\":\"https://mcp.exa.ai/mcp\",\"enabled\":false}}}"
fi

case "$MODE" in
  web)
    # In GitHub Codespaces, port 3000 is forwarded as PRIVATE (authenticated via your GitHub login).
    # Outside Codespaces, auto-generate a server password unless one is already provided.
    if [ -n "${OPENCODE_SERVER_PASSWORD:-}" ]; then
      export OPENCODE_SERVER_PASSWORD
    elif [ "${CODESPACES:-}" != "true" ]; then
      OPENCODE_SERVER_PASSWORD="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      export OPENCODE_SERVER_PASSWORD
      echo "==> Generated local OPENCODE_SERVER_PASSWORD (set OPENCODE_SERVER_PASSWORD to customize)."
    fi
    echo "==> Starting SAM web UI on 0.0.0.0:${PORT} with default model: ${SAM_MODEL}"
    echo "==> Codespaces port ${PORT} should be forwarded as PRIVATE."
    exec opencode web --hostname 0.0.0.0 --port "$PORT"
    ;;
  run)
    shift
    echo "==> Running SAM (headless, model: ${SAM_MODEL}): $*"
    BROWSER="" exec opencode run "$@" -m "$SAM_MODEL" --auto
    ;;
  tui|*)
    echo "==> Launching SAM TUI (model: ${SAM_MODEL})"
    exec opencode -m "$SAM_MODEL"
    ;;
esac
