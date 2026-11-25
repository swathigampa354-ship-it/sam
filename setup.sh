#!/usr/bin/env bash
# setup.sh — Install & configure SAM + OpenCode CLI (+ cloudflared public tunnel) inside GitHub Codespaces.
# Idempotent: safe to re-run. No paid keys required; defaults to OpenCode free models.
set -euo pipefail

echo "==> SAM deployment setup starting ($(date -u))"

export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin"

# 1. Ensure OpenCode CLI is on PATH
if ! command -v opencode >/dev/null 2>&1; then
  echo "==> Installing OpenCode CLI (latest compatible)..."
  curl -fsSL https://opencode.ai/install -o /tmp/opencode-install.sh
  bash /tmp/opencode-install.sh </dev/null
  rm -f /tmp/opencode-install.sh
else
  echo "==> OpenCode already installed: $(opencode --version)"
fi

# 2. Ensure cloudflared is installed for direct public HTTPS mobile access
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "==> Installing cloudflared (free public HTTPS tunnel)..."
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$HOME/.local/bin/cloudflared"
  chmod +x "$HOME/.local/bin/cloudflared"
else
  echo "==> cloudflared already installed: $(cloudflared --version | head -1)"
fi

# 3. Persist PATH for future shells
for rc in "$HOME/.bashrc" "$HOME/.profile"; do
  if [ -f "$rc" ] && ! grep -q '.opencode/bin' "$rc"; then
    printf '\n# OpenCode & local binaries\nexport PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"\n' >> "$rc"
  fi
done

# 4. Default model (free, no API key, no cost)
SAM_MODEL="${SAM_MODEL:-opencode/mimo-v2.6-flash-free}"
echo "==> Default model: ${SAM_MODEL}"
echo "    Other free options: opencode/beam-free, opencode/flint-40b-free, opencode/deepseek-v4.1-flash-free"

mkdir -p "$HOME/.config/opencode"
cat > "$HOME/.config/opencode/opencode.jsonc" <<EOF
{
  "model": "${SAM_MODEL}",
  "theme": "dark"
}
EOF

# 5. Verify SAM agents
echo "==> Verifying OpenCode agents..."
OPENCODE_CONFIG_CONTENT="{\"model\":\"${SAM_MODEL}\",\"mcp\":{\"exa\":{\"type\":\"remote\",\"url\":\"https://mcp.exa.ai/mcp\",\"enabled\":false}}}" \
  BROWSER="" timeout 20 opencode agent list </dev/null 2>&1 | head -30 || true

if command -v node >/dev/null 2>&1; then
  echo "==> node: $(node --version)"
fi

echo
echo "==> Setup complete."
echo "    Launch TUI : ./start.sh"
echo "    Web UI     : ./start.sh web"
echo "    Headless   : ./start.sh run \"<your content request>\""
