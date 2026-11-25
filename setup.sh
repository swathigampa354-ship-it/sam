#!/usr/bin/env bash
# setup.sh — Install & configure SAM + OpenCode CLI inside GitHub Codespaces.
# Idempotent: safe to re-run. No paid keys required; defaults to OpenCode free models.
set -euo pipefail

echo "==> SAM deployment setup starting ($(date -u))"

# 1. Ensure OpenCode CLI is on PATH
export PATH="$HOME/.opencode/bin:$PATH"
if ! command -v opencode >/dev/null 2>&1; then
  echo "==> Installing OpenCode CLI (latest compatible)..."
  curl -fsSL https://opencode.ai/install | bash
else
  echo "==> OpenCode already installed: $(opencode --version)"
fi
export PATH="$HOME/.opencode/bin:$PATH"

# 2. Persist PATH for future shells (interactive Codespaces terminals)
for rc in "$HOME/.bashrc" "$HOME/.profile"; do
  if [ -f "$rc" ] && ! grep -q '.opencode/bin' "$rc"; then
    printf '\n# OpenCode CLI\nexport PATH="$HOME/.opencode/bin:$PATH"\n' >> "$rc"
  fi
done

# 3. Default model (free, no API key, no cost). Override with SAM_MODEL env / .env.
SAM_MODEL="${SAM_MODEL:-opencode/deepseek-v4.1-flash-free}"
echo "==> Default model: ${SAM_MODEL}"
echo "    Other free options: opencode/nemotron-3.5-lightning-free, opencode/beam-free, opencode/hy4-flash-free"

# 4. Optional global OpenCode config (theme + default). The project opencode.jsonc
#    still controls `model`, so start.sh always passes -m to guarantee the free model.
mkdir -p "$HOME/.config/opencode"
cat > "$HOME/.config/opencode/opencode.jsonc" <<EOF
{
  "model": "${SAM_MODEL}",
  "theme": "dark"
}
EOF

# 5. Verify the SAM agents are recognized by OpenCode
echo "==> Verifying OpenCode agents (SAM agents must appear)..."
opencode agent list 2>&1 | sed -n '1,60p' || true

# 6. Verify Node (required by SAM's analyzer/normalize scripts)
if command -v node >/dev/null 2>&1; then
  echo "==> node: $(node --version)"
else
  echo "==> WARNING: node not found; SAM analyzer scripts need Node 20+."
fi

echo
echo "==> Setup complete."
echo "    Launch TUI : ./start.sh"
echo "    Web UI     : ./start.sh web   (then open the forwarded :${SAM_PORT:-3000} port, PRIVATE)"
echo "    Headless   : ./start.sh run \"<your content request>\""
