# SAM — 24/7 Free-Tier Production Deployment & Architecture Guide

## Live Production URL
- **24/7 Public Web Application:** `https://swathigampa354-ship-it.github.io/sam/`
- **Repository:** `https://github.com/swathigampa354-ship-it/sam`

---

## 1. Architecture Overview (₹0 Recurring Operating Cost)

SAM runs as a **zero-sleep, multi-tier edge architecture** designed to stay online 24/7/365 with zero credit cards and zero unexpected billing:

1. **Frontend & Canonical Deterministic Engine (`gh-pages` branch → GitHub Pages Fastly CDN):**
   - Serves the mobile-compatible web studio at `https://swathigampa354-ship-it.github.io/sam/` (`0 ms` cold start, `100 GB/month` recurring bandwidth).
   - Imports SAM's exact zero-dependency ES modules (`lib/analyzers/{markdown,readability,structure,publish-readiness,keyword,normalize,report}.mjs`) directly in the browser and edge worker—100% parity with CLI scripts (`scripts/analyze-draft.mjs` and `scripts/normalize-draft.mjs`).
   - Supports both SAM bold metadata (`**Meta Title**: ...`) and YAML frontmatter (`---\nmeta_title: ...\n---`).

2. **24/7 Edge AI Backend & Multi-Provider Failover Router (`worker/index.mjs` + `wrangler.toml`):**
   - **Tier 1 — Cloudflare Workers + Workers AI (`worker/index.mjs`):** `100,000 req/day` free + `10,000 Neurons/day` free keyless GPU inference (`@cf/openai/gpt-oss-120b` → `@cf/openai/gpt-oss-20b` → `@cf/meta/llama-3.3-70b-instruct-fp8-fast` → `@cf/meta/llama-3.1-8b-instruct-fast`), with optional server-side encrypted secrets (`GROQ_API_KEY`, `GEMINI_API_KEY`) if ever added.
   - **Tier 2 — OpenCode CLI / Codespace Tunnel (Optional Dev Mode):** Automatically detected via `live-backend.json` when running `./start.sh web`.
   - **Tier 3 — Direct Keyless Edge AI (`https://text.pollinations.ai/openai`, `gpt-oss-20b`):** Built-in SSE streaming fallback with automatic rate-limit window queueing (`1 req / 45s / IP` when keyless) so `https://swathigampa354-ship-it.github.io/sam/` remains 100% functional 24/7 even with zero external backend accounts.

3. **Caching, Quota Management & Rate Limiting:**
   - **SHA-256 Response Cache:** Identical `(agent, context, prompt)` requests return in `<50 ms` (`CACHE HIT`, `0` tokens/Neurons consumed) via KV + in-isolate LRU + browser `localStorage` (1-hour TTL).
   - **Adaptive Quota Budgeting:** Tracks daily Neuron consumption (`DAILY_NEURON_BUDGET=9500` out of `10,000` free daily Neurons) and automatically shifts from `120b` to `20b`/`8b` above 70% utilization (~4× capacity extension).
   - **Abuse Protection:** Sliding-window per-IP rate limiter (`20 req/min`, `HTTP 429` + `Retry-After`).

---

## 2. Optional: Activating Tier-1 Cloudflare Worker (`*.workers.dev`)

`deploy-worker.yml` is pre-configured in `.github/workflows/deploy-worker.yml`:
1. Create a free Cloudflare API Token (`Edit Cloudflare Workers` + `Workers AI: Edit`) at `https://dash.cloudflare.com/profile/api-tokens`.
2. Add it as a repository secret named `CLOUDFLARE_API_TOKEN` in `Settings → Secrets and variables → Actions`, then trigger **Deploy SAM Cloudflare Worker** (or paste the token to deploy via `npx wrangler deploy` and set `worker_url` in `live-backend.json`).

---

## 3. Verification Commands

```bash
# Run full automated test suite (agent sync, dual-format analyzers, normalizer, edge worker fallback/cache/rate-limit)
node --test tests/

# CLI draft analysis & normalization
node ./scripts/normalize-draft.mjs example_draft.md
node ./scripts/analyze-draft.mjs example_draft.md --keyword "keyword research"
```
