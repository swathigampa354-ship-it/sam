#!/usr/bin/env bash
# start.sh — Launch SAM (OpenCode) inside GitHub Codespaces (public mobile-ready mode).
#
#   ./start.sh            -> interactive TUI (free model)
#   ./start.sh web        -> native OpenCode web UI on 0.0.0.0:$SAM_PORT + public HTTPS tunnel
#   ./start.sh run "..."  -> one-shot headless content generation
set -euo pipefail
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"

SAM_MODEL="${SAM_MODEL:-opencode/mimo-v2.6-flash-free}"
PORT="${SAM_PORT:-3000}"
PAGES_ORIGIN="${SAM_PAGES_ORIGIN:-https://swathigampa354-ship-it.github.io}"
MODE="${1:-${SAM_MODE:-tui}}"

if [ -n "${EXA_API_KEY:-}" ]; then
  export OPENCODE_CONFIG_CONTENT="{\"model\":\"${SAM_MODEL}\",\"default_agent\":\"seo-guide\"}"
else
  export OPENCODE_CONFIG_CONTENT="{\"model\":\"${SAM_MODEL}\",\"default_agent\":\"seo-guide\",\"mcp\":{\"exa\":{\"type\":\"remote\",\"url\":\"https://mcp.exa.ai/mcp\",\"enabled\":false}}}"
fi

start_public_tunnel_bg() {
  if ! command -v cloudflared >/dev/null 2>&1; then
    return 0
  fi
  if ! pgrep -x cloudflared >/dev/null 2>&1; then
    rm -f /tmp/cloudflared.log
    nohup setsid cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" </dev/null >/tmp/cloudflared.log 2>&1 &
  fi
  # Background helper: once tunnel URL appears, sync live-backend.json to gh-pages if Codespaces token is present
  (
    for _ in $(seq 1 20); do
      CF_URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/cloudflared.log 2>/dev/null | head -1 || true)
      [ -n "$CF_URL" ] && break
      sleep 1
    done
    if [ -n "${CF_URL:-}" ]; then
      echo "$CF_URL" > /tmp/sam_cf_url.txt
      echo "==> Public Cloudflare HTTPS URL: $CF_URL"
      if [ -f /workspaces/.codespaces/shared/.env-secrets ]; then
        python3 - "$CF_URL" "$SAM_MODEL" "$PORT" << 'PY' || true
import base64, datetime, json, sys, urllib.request
cf_url, model, port = sys.argv[1], sys.argv[2], sys.argv[3]
env = {}
with open("/workspaces/.codespaces/shared/.env-secrets") as f:
    for line in f:
        if "=" in line:
            k, v = line.strip().split("=", 1)
            try:
                env[k] = base64.b64decode(v).decode()
            except Exception:
                pass
token = env.get("GITHUB_TOKEN", "")
repo = env.get("GITHUB_REPOSITORY", "swathigampa354-ship-it/sam")
cs_name = env.get("CODESPACE_NAME", "")
domain = env.get("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN", "app.github.dev")
if token and repo:
    payload = {
        "cloudflare_url": cf_url,
        "codespace_port_url": f"https://{cs_name}-{port}.{domain}" if cs_name else "",
        "codespace_editor_url": f"https://{cs_name}.github.dev" if cs_name else "",
        "model": model,
        "agent": "seo-guide",
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }
    api_url = f"https://api.github.com/repos/{repo}/contents/live-backend.json"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "sam-codespace"}
    sha = None
    try:
        req = urllib.request.Request(f"{api_url}?ref=gh-pages", headers=headers)
        with urllib.request.urlopen(req, timeout=10) as r:
            sha = json.loads(r.read()).get("sha")
    except Exception:
        pass
    body = {
        "message": "Update live SAM Codespace tunnel endpoint",
        "content": base64.b64encode((json.dumps(payload, indent=2) + "\n").encode()).decode(),
        "branch": "gh-pages"
    }
    if sha:
        body["sha"] = sha
    req2 = urllib.request.Request(api_url, data=json.dumps(body).encode(), headers={**headers, "Content-Type": "application/json"}, method="PUT")
    urllib.request.urlopen(req2, timeout=10).read()
PY
      fi
    fi
  ) >/tmp/sam-tunnel-sync.log 2>&1 &
}

case "$MODE" in
  web)
    if [ -n "${OPENCODE_SERVER_PASSWORD:-}" ]; then
      export OPENCODE_SERVER_PASSWORD
    fi
    start_public_tunnel_bg
    echo "==> Starting SAM public web UI on 0.0.0.0:${PORT} (model: ${SAM_MODEL}, CORS: ${PAGES_ORIGIN})"
    exec opencode web --hostname 0.0.0.0 --port "$PORT" --cors "$PAGES_ORIGIN"
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
