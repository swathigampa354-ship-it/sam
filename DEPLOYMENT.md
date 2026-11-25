# SAM — Deployment & Operations Guide (GitHub Codespaces)

> **What SAM is:** SAM is not a standalone binary. It is a set of OpenCode/Claude-Code
> **agent definitions** (`.opencode/agents/*`), Node analyzer scripts (`scripts/`),
> templates, and docs. It runs *inside* a coding-agent harness — here, **OpenCode CLI**.
> This guide deploys the original `every-app/sam` repository into GitHub Codespaces and
> runs it at **zero cost** using OpenCode's free hosted models (no API key, no subscription).

---

## 1. Environment inspected (Codespaces-equivalent, smallest machine)

| Resource | Value |
|----------|-------|
| OS | Debian GNU/Linux 13 (trixie) / bookworm base |
| CPU | 2 vCPU (smallest Codespaces machine) |
| RAM | ~2–4 GB (2-core machine) |
| Disk | 25 GB+ (well within free storage) |
| Runtimes | Node.js 20, git, bash, curl |
| Network | Outbound HTTPS allowed |

The devcontainer uses the **smallest suitable** `devcontainers/base:debian` image plus
Node 20, Git, and the GitHub CLI features only. Choose the **2-core** Codespaces
machine to stay inside the free-tier allowance.

---

## 2. Repository

- Upstream: `https://github.com/every-app/sam`
- This deployment fork: `https://github.com/swathigampa354-ship-it/sam`
- Local working copy: `/workspaces/sam` (or wherever Codespaces clones it)

Clone / open:
```bash
git clone https://github.com/swathigampa354-ship-it/sam.git
cd sam
```

---

## 3. Install & configure

`setup.sh` is **idempotent** and runs automatically via `postCreateCommand` in the
devcontainer. It:
1. Installs the latest OpenCode CLI into `~/.opencode/bin` (adds it to PATH).
2. Writes a global OpenCode config (theme + default model).
3. Verifies all SAM agents are recognized (`opencode agent list`).
4. Confirms Node 20 is present for the analyzer scripts.

Manual install (outside Codespaces):
```bash
bash setup.sh
```

### AI provider / model strategy (₹0 budget)
- **Default: OpenCode free models** — `opencode/mimo-v2.6-flash-free` (and backups like `opencode/beam-free`, `opencode/flint-40b-free`, `opencode/deepseek-v4.1-flash-free`).
  These are hosted by OpenCode, require **no API key**, and cost **nothing**.
  Selected at runtime with `-m`, so the original `opencode.jsonc` (which names the
  paid `openai/gpt-5.4`) is left **untouched** — preserving architecture.
- **Optional — GitHub Models (also free):** your GitHub Copilot entitlement allows
  free inference via `https://models.inference.ai.azure.com` using the Codespaces
  `GITHUB_TOKEN` (auto-injected). Configure a custom OpenAI-compatible provider in
  `opencode.jsonc` with `base_url` = that endpoint and `api_key` = `$GITHUB_TOKEN`,
  then set `SAM_MODEL=github/<model>`.
- **Optional — OpenAI GPT-5.4 (paid):** the upstream default. Set `OPENAI_API_KEY`
  and `SAM_MODEL=openai/gpt-5.4`. Not used here (budget = ₹0).

### Secrets (never committed)
Set these as **Codespaces secrets** or shell env vars — never hard-code:
- `OPENCODE_SERVER_PASSWORD` — secures the web UI (auto-generated if empty).
- `OPENAI_API_KEY` — only for the paid OpenAI path.
- `EXA_API_KEY` — only for the optional Exa web-search MCP.
- `GITHUB_TOKEN` — provided automatically inside Codespaces.

---

## 4. Run SAM

```bash
# Interactive TUI (recommended for onboarding / research / writing)
./start.sh

# Native browser UI — OpenCode web server on 0.0.0.0:$SAM_PORT
./start.sh web
#   -> Codespaces forwards port 3000 as PRIVATE; open the browser preview.
#   -> In the UI model picker, choose a free model, e.g. opencode/deepseek-v4.1-flash-free.

# One-shot headless content generation (great for tests / automation)
./start.sh run "Write a 300-word draft about <topic> and save it to drafts/<slug>.md"
```

The original intended execution method (`opencode`) is preserved; `start.sh` simply
adds `-m "$SAM_MODEL"` so the free model is used. For the web UI, pick the free model
in the in-browser picker.

### Typical workflow (driven by the `seo-guide` agent)
1. Onboarding — share your website; SAM scrapes it for brand voice & positioning.
2. Research — topic/keyword ideas (Exa MCP optional; otherwise from knowledge).
3. Writing — `seo-guide` delegates to the `article-writer` subagent, then runs
   `fact-checker` and `seo-reviewer` passes.
4. Outputs land in `research/` and `drafts/` with date-stamped slugs + YAML frontmatter.

---

## 5. Verify

```bash
# Run SAM's own test suite (agents in sync, analyzers correct)
node --test tests/

# Analyze a draft
node ./scripts/analyze-draft.mjs drafts/<file>.md --keyword "<kw>"

# Confirm agents are loaded
opencode agent list      # expect: seo-guide, article-writer, fact-checker, seo-reviewer (+build)

# Confirm OpenCode + free model work end-to-end
./start.sh run "Write a 200-word test post about remote work and save to drafts/_smoke.md"
ls -l drafts/_smoke.md
```

---

## 6. Reuse / restart

Everything is scripted — restarting a Codespace re-runs `setup.sh` automatically and
SAM is immediately runnable:

```bash
# Restart command (after the Codespace is up):
./start.sh            # or: ./start.sh web
```

No manual dependency reinstall is required; `setup.sh` is idempotent.

---

## 7. Known limitations

- **Free models are smaller** than GPT-5.4; output quality is good for drafts but may
  need more editing than the paid default.
- **Web research** requires the optional Exa MCP API key; without it, SAM writes from
  its own knowledge (the agent degrades gracefully per its instructions).
- `opencode web` does not accept a `-m` flag; choose the free model in the UI picker.
- The Exa MCP remote server in `opencode.jsonc` is left enabled but unauthenticated;
  it is simply unused until `EXA_API_KEY` is supplied.
