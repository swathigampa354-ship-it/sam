#!/usr/bin/env bash
# setup.sh — Local CLI setup for SAM (no temporary tunnels required; production runs on Cloudflare Workers + GitHub Pages).
set -euo pipefail

echo "==> SAM setup starting ($(date -u))"
export PATH="$HOME/.opencode/bin:$PATH"

if ! command -v opencode >/dev/null 2>&1; then
  echo "==> Installing OpenCode CLI..."
  curl -fsSL https://opencode.ai/install -o /tmp/opencode-install.sh
  bash /tmp/opencode-install.sh </dev/null
  rm -f /tmp/opencode-install.sh
else
  echo "==> OpenCode already installed: $(opencode --version)"
fi

for rc in "$HOME/.bashrc" "$HOME/.profile"; do
  if [ -f "$rc" ] && ! grep -q '.opencode/bin' "$rc"; then
    printf '\nexport PATH="$HOME/.opencode/bin:$PATH"\n' >> "$rc"
  fi
done

SAM_MODEL="${SAM_MODEL:-opencode/mimo-v2.6-flash-free}"
mkdir -p "$HOME/.config/opencode"
cat > "$HOME/.config/opencode/opencode.jsonc" <<EOF
{
  "model": "${SAM_MODEL}",
  "theme": "dark"
}
EOF

if command -v node >/dev/null 2>&1; then
  echo "==> node: $(node --version)"
fi
echo "==> Setup complete."
