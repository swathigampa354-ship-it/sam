#!/usr/bin/env bash
# start.sh — Local CLI / dev launcher for SAM (production runs 24/7 on Cloudflare Workers + GitHub Pages).
set -euo pipefail
export PATH="$HOME/.opencode/bin:$PATH"
cd "$(dirname "$0")"

SAM_MODEL="${SAM_MODEL:-opencode/mimo-v2.6-flash-free}"
PORT="${SAM_PORT:-3000}"
MODE="${1:-${SAM_MODE:-tui}}"

if [ -n "${EXA_API_KEY:-}" ]; then
  export OPENCODE_CONFIG_CONTENT="{\"model\":\"${SAM_MODEL}\",\"default_agent\":\"seo-guide\"}"
else
  export OPENCODE_CONFIG_CONTENT="{\"model\":\"${SAM_MODEL}\",\"default_agent\":\"seo-guide\",\"mcp\":{\"exa\":{\"type\":\"remote\",\"url\":\"https://mcp.exa.ai/mcp\",\"enabled\":false}}}"
fi

case "$MODE" in
  web)
    exec opencode web --hostname 127.0.0.1 --port "$PORT"
    ;;
  run)
    shift
    BROWSER="" exec opencode run "$@" -m "$SAM_MODEL" --auto
    ;;
  tui|*)
    exec opencode -m "$SAM_MODEL"
    ;;
esac
