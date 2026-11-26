import { normalizeContent } from "../lib/analyzers/normalize.mjs";
import { analyzeDraftContent } from "../lib/analyzers/report.mjs";

const AGENT_PROMPTS = {
  "seo-guide": {
    name: "seo-guide",
    mode: "primary",
    description: "Sam - SEO Guide for setup, research, drafting, and review work",
    system: [
      "You are Sam, the practical, calm SEO content teammate.",
      "Follow SAM rules strictly:",
      "- Match search intent first; reach the useful answer fast without filler or self-referential 'in this guide' intros.",
      "- Never leak internal methodology, star thresholds, or exclusion notes into reader-facing articles.",
      "- When creating an article draft, include SAM metadata at the top (**Meta Title**: ..., **Meta Description**: ..., **Primary Keyword**: ..., **Secondary Keywords**: ..., **URL Slug**: ..., **Category**: ..., **Tags**: ...), followed by a single `# H1` and scannable `## H2` sections.",
      "- If asked to save a file to `drafts/...` or `research/...`, wrap the markdown inside `<sam-file path=\"drafts/slug.md\">...</sam-file>` so the workspace persists it automatically.",
      "- Keep replies concise, concrete, and reader-first.",
    ].join("\n"),
  },
  "article-writer": {
    name: "article-writer",
    mode: "subagent",
    description: "Drafts publish-ready SEO articles and rewrites",
    system: [
      "You are SAM's article-writing specialist.",
      "Write publish-ready, reader-first SEO prose:",
      "- Start with SAM metadata lines (**Meta Title**: ..., **Meta Description**: ..., **Primary Keyword**: ..., **Secondary Keywords**: ..., **URL Slug**: ..., **Category**: ..., **Tags**: ...).",
      "- Use exactly one `# H1` containing the primary keyword naturally, reach the first `## H2` within ~120 words, and include the primary keyword in the first 100 words.",
      "- Keep sentences crisp (average <20 words), avoid methodology/process filler, and keep claims accurate and conservative.",
      "- Wrap saved drafts in `<sam-file path=\"drafts/slug.md\">...</sam-file>` when a path is requested.",
    ].join("\n"),
  },
  "fact-checker": {
    name: "fact-checker",
    mode: "subagent",
    description: "Audits factual claims, statistics, and unsupported assertions",
    system: [
      "You are SAM's factual accuracy specialist.",
      "Review the provided draft or topic for falsifiable claims, stats, dates, definitions, and product comparisons.",
      "Group concise findings under: Verified, Needs Citation, Soften Wording, or Remove/Replace, with concrete safer rewrites.",
    ].join("\n"),
  },
  "seo-reviewer": {
    name: "seo-reviewer",
    mode: "subagent",
    description: "Independently reviews drafts for publish readiness and search intent",
    system: [
      "You are SAM's independent SEO review specialist.",
      "Evaluate intro speed, search-intent match, title/meta quality, H1/H2 hierarchy, natural keyword placement, scannability, and process-note leakage.",
      "Separate Keep-As-Is strengths from Required Fixes and Optional Polish, and end with one verdict: `publish-ready`, `publish after required fixes`, or `needs substantial revision`.",
    ].join("\n"),
  },
};

// Official Cloudflare Workers AI Neuron rates per 1M tokens (fallback estimator when stream omits usage)
const MODEL_NEURON_RATES = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inPerM: 26668, outPerM: 204805 },
  "@cf/openai/gpt-oss-20b": { inPerM: 18182, outPerM: 27273 },
  "@cf/mistralai/mistral-small-3.1-24b-instruct": { inPerM: 31876, outPerM: 50488 },
  "@cf/meta/llama-3.1-8b-instruct-fast": { inPerM: 13778, outPerM: 26128 },
};

const memoryCache = new Map();
const memorySessions = new Map();
const memoryWorkspace = new Map([
  [
    "MEMORY.md",
    "# Sam Memory\n\n- Overall status: Ready\n- Runtime: Cloudflare Workers + Workers AI + KV (Free Plan)\n",
  ],
  [
    "context/seo-guidelines.md",
    "# SEO Guidelines\n- Match search intent.\n- One clear H1, scannable H2s, concise meta description.\n",
  ],
]);
const ipBuckets = new Map();
let quotaLoadedDay = "";
const dailyQuota = {
  day: "",
  neuronsUsed: 0,
  requests: 0,
  kvWrites: 0,
  cacheHits: 0,
  fallbacks: 0,
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

async function syncQuotaFromKV(env) {
  const d = todayKey();
  if (dailyQuota.day !== d) {
    dailyQuota.day = d;
    dailyQuota.neuronsUsed = 0;
    dailyQuota.requests = 0;
    dailyQuota.kvWrites = 0;
    dailyQuota.cacheHits = 0;
    dailyQuota.fallbacks = 0;
  }
  if (env?.SAM_KV && quotaLoadedDay !== d) {
    quotaLoadedDay = d;
    try {
      const saved = await env.SAM_KV.get(`quota:${d}`, "json");
      if (saved && saved.day === d) {
        dailyQuota.neuronsUsed = Math.max(dailyQuota.neuronsUsed, Number(saved.neuronsUsed || 0));
        dailyQuota.requests = Math.max(dailyQuota.requests, Number(saved.requests || 0));
        dailyQuota.kvWrites = Math.max(dailyQuota.kvWrites, Number(saved.kvWrites || 0));
        dailyQuota.cacheHits = Math.max(dailyQuota.cacheHits, Number(saved.cacheHits || 0));
        dailyQuota.fallbacks = Math.max(dailyQuota.fallbacks, Number(saved.fallbacks || 0));
      }
    } catch (_) {}
  }
}

async function persistQuotaToKV(env) {
  const maxKvWrites = Number(env?.HARD_DAILY_KV_WRITE_LIMIT || 900);
  if (!env?.SAM_KV || dailyQuota.kvWrites >= maxKvWrites) return;
  dailyQuota.kvWrites += 1;
  try {
    await env.SAM_KV.put(`quota:${dailyQuota.day}`, JSON.stringify(dailyQuota), {
      expirationTtl: 172800,
    });
  } catch (_) {}
}

function corsHeaders(request, env) {
  const reqOrigin = request.headers.get("Origin") || "";
  const allowed = env?.ALLOWED_ORIGIN || "https://swathigampa354-ship-it.github.io";
  const origin =
    !reqOrigin || reqOrigin === allowed || reqOrigin.startsWith("http://localhost")
      ? reqOrigin || allowed
      : allowed;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, X-SAM-Max-Neurons, X-SAM-Max-Requests, X-SAM-Disable-External-Fallback",
    "Access-Control-Expose-Headers":
      "X-SAM-Provider, X-SAM-Model, X-SAM-Cache, X-SAM-Neurons-Used, X-SAM-Neurons-Remaining, X-SAM-Fallbacks, Retry-After",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(data, status, request, env, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request, env),
      ...extraHeaders,
    },
  });
}

function checkRateLimit(ip, maxRpm) {
  const now = Date.now();
  const windowMs = 60_000;
  const timestamps = (ipBuckets.get(ip) || []).filter((t) => now - t < windowMs);
  if (timestamps.length >= maxRpm) {
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - timestamps[0])) / 1000));
    return { allowed: false, retryAfter };
  }
  timestamps.push(now);
  ipBuckets.set(ip, timestamps);
  return { allowed: true, retryAfter: 0 };
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function cacheGet(key, env) {
  const mem = memoryCache.get(key);
  if (mem && mem.expiresAt > Date.now()) return mem.value;
  if (mem) memoryCache.delete(key);
  if (env?.SAM_KV) {
    try {
      const raw = await env.SAM_KV.get(`cache:${key}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        memoryCache.set(key, { value: parsed, expiresAt: Date.now() + 600_000 });
        return parsed;
      }
    } catch (_) {}
  }
  return null;
}

async function cacheSet(key, value, ttlSec, env) {
  if (memoryCache.size > 250) {
    const oldest = memoryCache.keys().next().value;
    memoryCache.delete(oldest);
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  const maxKvWrites = Number(env?.HARD_DAILY_KV_WRITE_LIMIT || 900);
  if (env?.SAM_KV && dailyQuota.kvWrites < maxKvWrites) {
    dailyQuota.kvWrites += 1;
    try {
      await env.SAM_KV.put(`cache:${key}`, JSON.stringify(value), { expirationTtl: ttlSec });
    } catch (_) {}
  }
}

async function saveWorkspaceFile(path, content, env) {
  const cleanPath = path.replace(/^\/+/, "").replace(/\.\./g, "");
  const normalized = normalizeContent(content).content;
  memoryWorkspace.set(cleanPath, normalized);
  const maxKvWrites = Number(env?.HARD_DAILY_KV_WRITE_LIMIT || 900);
  if (env?.SAM_KV && dailyQuota.kvWrites < maxKvWrites) {
    dailyQuota.kvWrites += 1;
    try {
      await env.SAM_KV.put(`file:${cleanPath}`, normalized);
    } catch (_) {}
  }
  return cleanPath;
}

function estimateNeuronsFallback(modelId, inputChars, outputChars) {
  const rates = MODEL_NEURON_RATES[modelId] || { inPerM: 20000, outPerM: 40000 };
  const inTok = Math.ceil(inputChars / 4);
  const outTok = Math.ceil(outputChars / 4);
  return Number(((inTok * rates.inPerM + outTok * rates.outPerM) / 1_000_000).toFixed(4));
}

function extractWorkersAIText(result) {
  if (typeof result?.response === "string" && result.response.trim()) {
    return result.response.trim();
  }
  const msg = result?.choices?.[0]?.message;
  if (typeof msg?.content === "string" && msg.content.trim()) {
    return msg.content.replace(/^<\|start\|>assistant<\|channel\|>[a-z]*\s*/i, "").trim();
  }
  return "";
}

function getEffectiveHardCaps(request, env) {
  const baseNeuronCap = Number(env?.HARD_DAILY_NEURON_LIMIT || 9000);
  const baseReqCap = Number(env?.HARD_DAILY_REQUEST_LIMIT || 90000);
  const testNeuronHdr = request.headers.get("X-SAM-Max-Neurons");
  const testReqHdr = request.headers.get("X-SAM-Max-Requests");
  // Headers can ONLY lower (strictly tighten) the hard cap for verification, never raise it
  const neuronCap =
    testNeuronHdr !== null && !Number.isNaN(Number(testNeuronHdr))
      ? Math.max(0, Math.min(baseNeuronCap, Number(testNeuronHdr)))
      : baseNeuronCap;
  const reqCap =
    testReqHdr !== null && !Number.isNaN(Number(testReqHdr))
      ? Math.max(0, Math.min(baseReqCap, Number(testReqHdr)))
      : baseReqCap;
  const disableExternal = request.headers.get("X-SAM-Disable-External-Fallback") === "1";
  return { neuronCap, reqCap, disableExternal };
}

function selectWorkersAIModelOrder(neuronsUsed, neuronCap, preferredFirst = "") {
  const highUsage = neuronsUsed >= neuronCap * 0.6;
  const baseOrder = highUsage
    ? [
        "@cf/openai/gpt-oss-20b",
        "@cf/meta/llama-3.1-8b-instruct-fast",
        "@cf/mistralai/mistral-small-3.1-24b-instruct",
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      ]
    : [
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "@cf/openai/gpt-oss-20b",
        "@cf/mistralai/mistral-small-3.1-24b-instruct",
        "@cf/meta/llama-3.1-8b-instruct-fast",
      ];
  if (preferredFirst) {
    return [preferredFirst, ...baseOrder.filter((m) => m !== preferredFirst)];
  }
  return baseOrder;
}

async function callOpenAICompat({ url, apiKey, model, messages, maxTokens = 1400, timeoutMs = 30000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.4 }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 140)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    if (!text) throw new Error("Empty completion");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function runWithProviderFallback({
  messages,
  env,
  neuronCap,
  disableExternal = false,
  preferredModel = "",
}) {
  const errors = [];
  let localFallbacks = 0;
  const inputChars = messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);

  // 1. Primary: Cloudflare Workers AI (Free 10,000 Neurons/day with hard stop at neuronCap)
  if (env?.AI && dailyQuota.neuronsUsed < neuronCap) {
    const cfModels = selectWorkersAIModelOrder(dailyQuota.neuronsUsed, neuronCap, preferredModel);
    for (const cm of cfModels) {
      if (dailyQuota.neuronsUsed >= neuronCap) break;
      try {
        const aiOpts = cm.includes("gpt-oss")
          ? { messages, max_tokens: 1600, reasoning_effort: "low" }
          : { messages, max_tokens: 1200, temperature: 0.4 };
        const result = await env.AI.run(cm, aiOpts);
        const text = extractWorkersAIText(result);
        if (!text) throw new Error("Empty Workers AI output");
        const measuredNeurons =
          typeof result?.usage?.neurons === "number"
            ? Number(result.usage.neurons.toFixed(4))
            : estimateNeuronsFallback(cm, inputChars, text.length);
        dailyQuota.neuronsUsed = Number((dailyQuota.neuronsUsed + measuredNeurons).toFixed(4));
        return {
          text,
          provider: "cloudflare-workers-ai",
          model: cm,
          neurons: measuredNeurons,
          fallbacks: localFallbacks,
        };
      } catch (e) {
        dailyQuota.fallbacks += 1;
        localFallbacks += 1;
        errors.push(`workers-ai/${cm}: ${e.message}`);
      }
    }
  } else if (env?.AI && dailyQuota.neuronsUsed >= neuronCap) {
    errors.push(`workers-ai: Hard daily neuron limit reached (${dailyQuota.neuronsUsed}/${neuronCap})`);
  }

  // 2. Optional server-side free keys if configured
  if (env?.GROQ_API_KEY) {
    try {
      const text = await callOpenAICompat({
        url: "https://api.groq.com/openai/v1/chat/completions",
        apiKey: env.GROQ_API_KEY,
        model: "openai/gpt-oss-20b",
        messages,
      });
      return { text, provider: "groq-free", model: "openai/gpt-oss-20b", neurons: 0, fallbacks: localFallbacks };
    } catch (e) {
      dailyQuota.fallbacks += 1;
      localFallbacks += 1;
      errors.push(`groq: ${e.message}`);
    }
  }

  // 3. Keyless Pollinations OpenAI-compatible backup provider (unless disabled for strict hard-cap stop)
  if (!disableExternal) {
    try {
      const text = await callOpenAICompat({
        url: "https://text.pollinations.ai/openai",
        apiKey: "",
        model: "openai",
        messages,
        timeoutMs: 28000,
      });
      return { text, provider: "pollinations-free", model: "gpt-oss-20b", neurons: 0, fallbacks: localFallbacks };
    } catch (e) {
      dailyQuota.fallbacks += 1;
      localFallbacks += 1;
      errors.push(`pollinations: ${e.message}`);
    }
  }

  const quotaHit = dailyQuota.neuronsUsed >= neuronCap;
  const err = new Error(
    quotaHit
      ? `Hard daily free-tier AI quota reached (${dailyQuota.neuronsUsed.toFixed(1)}/${neuronCap} Neurons). Resets at 00:00 UTC.`
      : `All free AI providers unavailable: ${errors.join(" | ")}`,
  );
  err.code = quotaHit ? "HARD_QUOTA_STOP" : "PROVIDERS_UNAVAILABLE";
  throw err;
}

async function extractAndSaveFiles(replyText, env) {
  const saved = [];
  const regex = /<sam-file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/sam-file>/gi;
  let match;
  while ((match = regex.exec(replyText)) !== null) {
    const savedPath = await saveWorkspaceFile(match[1], match[2].trim(), env);
    const analysis = analyzeDraftContent(match[2].trim());
    saved.push({ path: savedPath, words: analysis.readability.words, summary: analysis.summary });
  }
  const cleaned = replyText.replace(regex, (_, p, body) => body.trim()).trim();
  return { cleaned, saved };
}

async function startWorkersAIStream({ messages, env, neuronCap, preferredModel = "" }) {
  if (!env?.AI || dailyQuota.neuronsUsed >= neuronCap) {
    return null;
  }
  const cfModels = selectWorkersAIModelOrder(dailyQuota.neuronsUsed, neuronCap, preferredModel);
  for (const cm of cfModels) {
    try {
      const aiOpts = cm.includes("gpt-oss")
        ? { messages, max_tokens: 1600, reasoning_effort: "low", stream: true }
        : { messages, max_tokens: 1200, temperature: 0.4, stream: true };
      const stream = await env.AI.run(cm, aiOpts);
      if (stream && typeof stream.getReader === "function") {
        return { stream, provider: "cloudflare-workers-ai", model: cm };
      }
    } catch (_) {
      dailyQuota.fallbacks += 1;
    }
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    await syncQuotaFromKV(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const { neuronCap, reqCap, disableExternal } = getEffectiveHardCaps(request, env);
    const maxRpm = Number(env?.RATE_LIMIT_RPM || 20);
    const ttlSec = Number(env?.CACHE_TTL_SECONDS || 3600);

    // Hard global request ceiling before Cloudflare's 100,000/day Free plan boundary
    if (path !== "/health" && path !== "/quota" && dailyQuota.requests >= reqCap) {
      const retrySec = secondsUntilUtcMidnight();
      return jsonResponse(
        {
          error: `Hard daily free request limit reached (${dailyQuota.requests}/${reqCap}). Requests stopped before any paid usage can occur.`,
          code: "HARD_QUOTA_STOP",
          resetInSeconds: retrySec,
        },
        429,
        request,
        env,
        { "Retry-After": String(retrySec) },
      );
    }

    if (path === "/" || path === "/health") {
      return jsonResponse(
        {
          ok: true,
          service: "sam-content-agent",
          runtime: "cloudflare-workers-free",
          default_agent: "seo-guide",
          primary_provider: "cloudflare-workers-ai",
          primary_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          kv_bound: Boolean(env?.SAM_KV),
          ai_bound: Boolean(env?.AI),
          quota: {
            day: dailyQuota.day,
            neuronsUsed: Number(dailyQuota.neuronsUsed.toFixed(2)),
            hardNeuronLimit: neuronCap,
            cloudflareFreeNeuronCeiling: 10000,
            neuronsRemaining: Number(Math.max(0, neuronCap - dailyQuota.neuronsUsed).toFixed(2)),
            requestsToday: dailyQuota.requests,
            hardRequestLimit: reqCap,
            kvWritesToday: dailyQuota.kvWrites,
            hardKvWriteLimit: Number(env?.HARD_DAILY_KV_WRITE_LIMIT || 900),
            cacheHitsToday: dailyQuota.cacheHits,
            fallbacksToday: dailyQuota.fallbacks,
            secondsUntilUtcReset: secondsUntilUtcMidnight(),
          },
        },
        200,
        request,
        env,
      );
    }

    if (path === "/config") {
      const agentMap = {};
      for (const [k, v] of Object.entries(AGENT_PROMPTS)) {
        agentMap[k] = { name: v.name, mode: v.mode, description: v.description };
      }
      const activePrimary =
        dailyQuota.neuronsUsed >= neuronCap * 0.6
          ? "@cf/openai/gpt-oss-20b"
          : "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
      return jsonResponse(
        {
          model: env?.AI ? activePrimary : "gpt-oss-20b",
          default_agent: "seo-guide",
          agent: agentMap,
          providers: [
            ...(env?.AI ? ["cloudflare-workers-ai"] : []),
            ...(env?.GROQ_API_KEY ? ["groq-free"] : []),
            "pollinations-free",
          ],
          quota: {
            neuronsUsed: Number(dailyQuota.neuronsUsed.toFixed(2)),
            neuronsRemaining: Number(Math.max(0, neuronCap - dailyQuota.neuronsUsed).toFixed(2)),
            neuronBudget: neuronCap,
            requestsToday: dailyQuota.requests,
            cacheHitsToday: dailyQuota.cacheHits,
          },
        },
        200,
        request,
        env,
      );
    }

    if (path === "/quota") {
      return jsonResponse(
        {
          day: dailyQuota.day,
          neuronsUsed: Number(dailyQuota.neuronsUsed.toFixed(2)),
          neuronBudget: neuronCap,
          neuronsRemaining: Number(Math.max(0, neuronCap - dailyQuota.neuronsUsed).toFixed(2)),
          requestsToday: dailyQuota.requests,
          hardRequestLimit: reqCap,
          kvWritesToday: dailyQuota.kvWrites,
          cacheHitsToday: dailyQuota.cacheHits,
          fallbacksToday: dailyQuota.fallbacks,
          secondsUntilUtcReset: secondsUntilUtcMidnight(),
        },
        200,
        request,
        env,
      );
    }

    if (path === "/analyze" && request.method === "POST") {
      dailyQuota.requests += 1;
      const body = await request.json().catch(() => ({}));
      return jsonResponse(
        analyzeDraftContent(String(body.content || ""), String(body.keyword || "")),
        200,
        request,
        env,
      );
    }

    if (path === "/normalize" && request.method === "POST") {
      dailyQuota.requests += 1;
      const body = await request.json().catch(() => ({}));
      return jsonResponse(normalizeContent(String(body.content || "")), 200, request, env);
    }

    if (path === "/workspace" && request.method === "GET") {
      const files = {};
      for (const [k, v] of memoryWorkspace.entries()) files[k] = v;
      return jsonResponse({ files }, 200, request, env);
    }

    if (path === "/workspace/file" && request.method === "PUT") {
      dailyQuota.requests += 1;
      const body = await request.json().catch(() => ({}));
      if (!body.path) return jsonResponse({ error: "Missing path" }, 400, request, env);
      const savedPath = await saveWorkspaceFile(String(body.path), String(body.content || ""), env);
      return jsonResponse({ ok: true, path: savedPath }, 200, request, env);
    }

    if (path === "/session" && request.method === "GET") {
      return jsonResponse([...memorySessions.values()], 200, request, env);
    }

    if (path === "/session" && request.method === "POST") {
      dailyQuota.requests += 1;
      const body = await request.json().catch(() => ({}));
      const id = "ses_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
      const session = {
        id,
        title: String(body.title || "SAM Session"),
        createdAt: Date.now(),
        messages: [],
      };
      memorySessions.set(id, session);
      return jsonResponse(session, 200, request, env);
    }

    const sessionMsgMatch = path.match(/^\/session\/([^/]+)\/(message|stream)$/);
    if (sessionMsgMatch && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      const rl = checkRateLimit(ip, maxRpm);
      if (!rl.allowed) {
        return jsonResponse(
          {
            error: `Rate limit exceeded (${maxRpm} req/min). Retry in ${rl.retryAfter}s.`,
            code: "RATE_LIMITED",
          },
          429,
          request,
          env,
          { "Retry-After": String(rl.retryAfter) },
        );
      }

      const sid = sessionMsgMatch[1];
      const routeMode = sessionMsgMatch[2];
      let session = memorySessions.get(sid);
      if (!session) {
        session = { id: sid, title: "SAM Session", createdAt: Date.now(), messages: [] };
        memorySessions.set(sid, session);
      }

      const body = await request.json().catch(() => ({}));
      const wantStream = routeMode === "stream" || Boolean(body.stream);
      const agentKey = AGENT_PROMPTS[body.agent] ? body.agent : "seo-guide";
      const agentDef = AGENT_PROMPTS[agentKey];
      const preferredModel = typeof body.preferModel === "string" ? body.preferModel : "";
      const activeFileCtx = typeof body.activeFileContent === "string" ? body.activeFileContent.slice(0, 1200) : "";

      const userText = (body.parts || [])
        .filter((p) => p?.type === "text" && p.text)
        .map((p) => p.text.trim())
        .join("\n")
        .trim();

      if (!userText) {
        return jsonResponse({ error: "Empty prompt" }, 400, request, env);
      }

      dailyQuota.requests += 1;
      const noCache = url.searchParams.get("nocache") === "1" || Boolean(body.noCache);
      const historySlice = session.messages.slice(-6);
      const cacheKey = await sha256Hex(
        JSON.stringify({ agent: agentKey, history: historySlice, activeFileCtx, prompt: userText }),
      );

      if (!noCache) {
        const cached = await cacheGet(cacheKey, env);
        if (cached) {
          dailyQuota.cacheHits += 1;
          const remStr = String(Math.max(0, neuronCap - dailyQuota.neuronsUsed).toFixed(2));
          if (wantStream) {
            const sseBody = [
              `data: ${JSON.stringify({ delta: cached.payload.parts?.[0]?.text || "" })}\n\n`,
              `data: ${JSON.stringify({
                done: true,
                cache: "HIT",
                info: cached.payload.info,
              })}\n\n`,
              `data: [DONE]\n\n`,
            ].join("");
            return new Response(sseBody, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache",
                ...corsHeaders(request, env),
                "X-SAM-Cache": "HIT",
                "X-SAM-Provider": cached.provider,
                "X-SAM-Model": cached.model,
                "X-SAM-Neurons-Remaining": remStr,
              },
            });
          }
          return jsonResponse(cached.payload, 200, request, env, {
            "X-SAM-Cache": "HIT",
            "X-SAM-Provider": cached.provider,
            "X-SAM-Model": cached.model,
            "X-SAM-Neurons-Remaining": remStr,
          });
        }
      }

      const memorySummary = memoryWorkspace.get("MEMORY.md") || "";
      const sysParts = [agentDef.system, `Workspace Memory:\n${memorySummary.slice(0, 500)}`];
      if (activeFileCtx) sysParts.push(`Active Draft Context:\n${activeFileCtx}`);
      const messages = [
        { role: "system", content: sysParts.join("\n\n") },
        ...historySlice,
        { role: "user", content: userText },
      ];

      // SSE Streaming path
      if (wantStream) {
        const aiStreamInit = await startWorkersAIStream({
          messages,
          env,
          neuronCap,
          preferredModel,
        });

        if (aiStreamInit) {
          const inputChars = messages.reduce((a, m) => a + (m.content?.length || 0), 0);
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();

          const pumpPromise = (async () => {
            const reader = aiStreamInit.stream.getReader();
            let buf = "";
            let assembled = "";
            let reportedNeurons = null;
            try {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split("\n");
                buf = lines.pop() || "";
                for (const raw of lines) {
                  const ln = raw.trim();
                  if (!ln.startsWith("data: ")) continue;
                  const payloadStr = ln.slice(6).trim();
                  if (payloadStr === "[DONE]") continue;
                  try {
                    const j = JSON.parse(payloadStr);
                    if (typeof j?.usage?.neurons === "number") {
                      reportedNeurons = j.usage.neurons;
                    }
                    const delta =
                      (typeof j?.response === "string" ? j.response : "") ||
                      j?.choices?.[0]?.delta?.content ||
                      "";
                    if (delta) {
                      assembled += delta;
                      await writer.write(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
                    }
                  } catch (_) {}
                }
              }

              const neurons =
                reportedNeurons !== null
                  ? Number(reportedNeurons.toFixed(4))
                  : estimateNeuronsFallback(aiStreamInit.model, inputChars, assembled.length);
              dailyQuota.neuronsUsed = Number((dailyQuota.neuronsUsed + neurons).toFixed(4));

              const { cleaned, saved } = await extractAndSaveFiles(assembled, env);
              session.messages.push({ role: "user", content: userText });
              session.messages.push({ role: "assistant", content: cleaned });

              const info = {
                sessionID: sid,
                agent: agentKey,
                providerID: aiStreamInit.provider,
                modelID: aiStreamInit.model,
                neuronsUsed: neurons,
                neuronsRemaining: Number(Math.max(0, neuronCap - dailyQuota.neuronsUsed).toFixed(2)),
                savedFiles: saved,
              };
              const finalPayload = { info, parts: [{ type: "text", text: cleaned }] };
              await cacheSet(
                cacheKey,
                { payload: finalPayload, provider: aiStreamInit.provider, model: aiStreamInit.model },
                ttlSec,
                env,
              );
              await persistQuotaToKV(env);

              await writer.write(
                encoder.encode(`data: ${JSON.stringify({ done: true, cache: "MISS", info })}\n\n`),
              );
              await writer.write(encoder.encode("data: [DONE]\n\n"));
            } catch (streamErr) {
              await writer.write(
                encoder.encode(`data: ${JSON.stringify({ error: streamErr.message })}\n\n`),
              );
            } finally {
              await writer.close().catch(() => {});
            }
          })();

          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(pumpPromise);
          }

          return new Response(readable, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              ...corsHeaders(request, env),
              "X-SAM-Cache": "MISS",
              "X-SAM-Provider": aiStreamInit.provider,
              "X-SAM-Model": aiStreamInit.model,
            },
          });
        }
      }

      // Non-streaming path (or fallback when Workers AI stream unavailable/quota-capped)
      try {
        const result = await runWithProviderFallback({
          messages,
          env,
          neuronCap,
          disableExternal,
          preferredModel,
        });
        const { cleaned, saved } = await extractAndSaveFiles(result.text, env);

        session.messages.push({ role: "user", content: userText });
        session.messages.push({ role: "assistant", content: cleaned });

        const info = {
          sessionID: sid,
          agent: agentKey,
          providerID: result.provider,
          modelID: result.model,
          neuronsUsed: result.neurons,
          neuronsRemaining: Number(Math.max(0, neuronCap - dailyQuota.neuronsUsed).toFixed(2)),
          fallbacks: result.fallbacks,
          savedFiles: saved,
        };
        const payload = { info, parts: [{ type: "text", text: cleaned }] };

        const bgSave = Promise.all([
          cacheSet(
            cacheKey,
            { payload, provider: result.provider, model: result.model },
            ttlSec,
            env,
          ),
          persistQuotaToKV(env),
        ]);
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(bgSave);
        else await bgSave;

        const extraHdrs = {
          "X-SAM-Cache": "MISS",
          "X-SAM-Provider": result.provider,
          "X-SAM-Model": result.model,
          "X-SAM-Neurons-Used": String(result.neurons),
          "X-SAM-Neurons-Remaining": String(info.neuronsRemaining),
          "X-SAM-Fallbacks": String(result.fallbacks || 0),
        };

        if (wantStream) {
          const sseBody = [
            `data: ${JSON.stringify({ delta: cleaned })}\n\n`,
            `data: ${JSON.stringify({ done: true, cache: "MISS", info })}\n\n`,
            `data: [DONE]\n\n`,
          ].join("");
          return new Response(sseBody, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              ...corsHeaders(request, env),
              ...extraHdrs,
            },
          });
        }

        return jsonResponse(payload, 200, request, env, extraHdrs);
      } catch (err) {
        const isQuota = err.code === "HARD_QUOTA_STOP";
        const retrySec = secondsUntilUtcMidnight();
        return jsonResponse(
          {
            error: err.message || "Generation failed across providers",
            code: err.code || "PROVIDER_ERROR",
            resetInSeconds: isQuota ? retrySec : 30,
          },
          isQuota ? 429 : 503,
          request,
          env,
          isQuota ? { "Retry-After": String(retrySec) } : {},
        );
      }
    }

    return jsonResponse({ error: "Not found", path }, 404, request, env);
  },
};
