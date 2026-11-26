# SAM — 24/7 Free-Tier Production Deployment & Architecture Guide

## Live Production Endpoints
- **24/7 Public Web Application (GitHub Pages CDN):** `https://swathigampa354-ship-it.github.io/sam/`
- **24/7 Edge AI Backend (Cloudflare Workers + Workers AI + KV):** `https://sam-content-agent.uberfor361.workers.dev`
- **Repository:** `https://github.com/swathigampa354-ship-it/sam`

---

## 1. Architecture Overview (₹0 Permanent Operating Cost)

SAM runs as a **zero-sleep, permanent free-tier edge architecture** with zero temporary tunnels, zero Codespace dependencies, and hard usage caps enforced before paid usage is ever possible:

1. **Frontend & Canonical Deterministic Engine (`gh-pages` branch → GitHub Pages Fastly CDN):**
   - Serves the mobile-compatible web studio at `https://swathigampa354-ship-it.github.io/sam/` (`0 ms` cold start, `100 GB/month` recurring bandwidth).
   - Imports SAM's zero-dependency ES modules (`lib/analyzers/{markdown,readability,structure,publish-readiness,keyword,normalize,report}.mjs`) identically in the browser, Cloudflare Worker, and CLI scripts.

2. **24/7 Edge AI Backend & Multi-Provider Failover Router (`worker/index.mjs` + `wrangler.toml`):**
   - **Primary — Cloudflare Workers AI (`env.AI`):** `10,000 Neurons/day` free recurring inference (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` → `@cf/openai/gpt-oss-20b` → `@cf/mistralai/mistral-small-3.1-24b-instruct` → `@cf/meta/llama-3.1-8b-instruct-fast`) with live SSE streaming (`POST /session/:id/stream`).
   - **Persistent Edge Cache & Workspace (`SAM_KV`):** Cloudflare Workers KV (`100,000 reads/day`, `1,000 writes/day`, `1 GB` storage free) stores SHA-256 response caches, workspace drafts, and daily quota counters.
   - **Backup — Keyless Free Edge AI (`https://text.pollinations.ai/openai`, `gpt-oss-20b`):** Automatic zero-key fallback if Workers AI models encounter transient regional unavailability.

3. **Hard Free-Tier Safety Limits (Stops Before Paid Usage):**
   - `HARD_DAILY_NEURON_LIMIT = 9000` (hard-stops Workers AI at `9,000` / `10,000` free daily Neurons; auto-promotes `@cf/openai/gpt-oss-20b` above `60%` daily Neuron usage to extend article capacity ~5×).
   - `HARD_DAILY_REQUEST_LIMIT = 90000` (hard-stops Worker invocations at `90,000` / `100,000` free daily requests with `HTTP 429 HARD_QUOTA_STOP` + `Retry-After` until `00:00 UTC`).
   - `HARD_DAILY_KV_WRITE_LIMIT = 900` (caps KV writes at `900` / `1,000` free daily writes).
   - Per-IP sliding-window rate limit (`20 req/min`, `HTTP 429` + `Retry-After`).

---

## 2. Automated CI/CD Deployment (`.github/workflows/deploy-worker.yml`)

- Encrypted repository secret `CLOUDFLARE_API_TOKEN` is stored in GitHub Actions secrets (never committed to git).
- Pushing changes to `worker/**`, `lib/analyzers/**`, or `wrangler.toml` on `main` automatically runs `node --test tests/` and deploys to `https://sam-content-agent.uberfor361.workers.dev`.

---

## 3. Verification Commands

```bash
node --test tests/
curl -s https://sam-content-agent.uberfor361.workers.dev/health
```
