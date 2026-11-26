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
      "- When creating an article draft, include SAM metadata at the top (**Meta Title**, **Meta Description**, **Primary Keyword**, **Secondary Keywords**, **URL Slug**, **Category**, **Tags**), followed by a single `# H1` and scannable `## H2` sections.",
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
      "- Start with SAM metadata lines (**Meta Title**, **Meta Description**, **Primary Keyword**, **Secondary Keywords**, **URL Slug**, **Category**, **Tags**).",
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

// In-isolate caches & state fallback when KV is not bound
const memoryCache = new Map();
const memorySessions = new Map();
const memoryWorkspace = new Map([
  [
    "MEMORY.md",
    "# Sam Memory\n\n- Overall status: Ready\n- Runtime: Cloudflare Edge + Free AI Router\n",
  ],
  [
    "context/seo-guidelines.md",
    "# SEO Guidelines\n- Match search intent.\n- One clear H1, scannable H2s, concise meta description.\n",
  ],
]);
const ipBuckets = new Map();
const dailyQuota = { day: "", neuronsUsed: 0, requests: 0, cacheHits: 0, fallbacks: 0 };

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetQuotaIfNewDay() {
  const d = todayKey();
  if (dailyQuota.day !== d) {
    dailyQuota.day = d;
    dailyQuota.neuronsUsed = 0;
    dailyQuota.requests = 0;
    dailyQuota.cacheHits = 0;
    dailyQuota.fallbacks = 0;
  }
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Expose-Headers": "X-SAM-Provider, X-SAM-Model, X-SAM-Cache, X-SAM-Neurons-Remaining",
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
      if (raw) return JSON.parse(raw);
    } catch (_) {}
  }
  return null;
}

async function cacheSet(key, value, ttlSec, env) {
  if (memoryCache.size > 200) {
    const oldest = memoryCache.keys().next().value;
    memoryCache.delete(oldest);
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  if (env?.SAM_KV) {
    try {
      await env.SAM_KV.put(`cache:${key}`, JSON.stringify(value), { expirationTtl: ttlSec });
    } catch (_) {}
  }
}

async function saveWorkspaceFile(path, content, env) {
  const cleanPath = path.replace(/^\/+/, "").replace(/\.\./g, "");
  const normalized = normalizeContent(content).content;
  memoryWorkspace.set(cleanPath, normalized);
  if (env?.SAM_KV) {
    try {
      await env.SAM_KV.put(`file:${cleanPath}`, normalized);
    } catch (_) {}
  }
  return cleanPath;
}

function estimateNeurons(modelId, inputChars, outputChars) {
  const inTok = Math.ceil(inputChars / 4);
  const outTok = Math.ceil(outputChars / 4);
  if (modelId.includes("120b") || modelId.includes("70b") || modelId.includes("72b")) {
    return Math.ceil(inTok * 0.03 + outTok * 0.12);
  }
  return Math.ceil(inTok * 0.008 + outTok * 0.03);
}

async function callOpenAICompat({ url, apiKey, model, messages, maxTokens = 1400, timeoutMs = 35000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.5 }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 160)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    if (!text) throw new Error("Empty completion");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function runWithProviderFallback({ messages, env }) {
  resetQuotaIfNewDay();
  const budget = Number(env?.DAILY_NEURON_BUDGET || 9500);
  const errors = [];
  const inputChars = messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);

  // 1. Optional server-side free API keys (Groq / Gemini / OpenRouter) if configured
  if (env?.GROQ_API_KEY) {
    for (const gm of ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]) {
      try {
        const text = await callOpenAICompat({
          url: "https://api.groq.com/openai/v1/chat/completions",
          apiKey: env.GROQ_API_KEY,
          model: gm,
          messages,
        });
        return { text, provider: "groq-free", model: gm, neurons: 0 };
      } catch (e) {
        dailyQuota.fallbacks += 1;
        errors.push(`groq/${gm}: ${e.message}`);
      }
    }
  }

  if (env?.GEMINI_API_KEY) {
    try {
      const text = await callOpenAICompat({
        url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        apiKey: env.GEMINI_API_KEY,
        model: "gemini-2.5-flash",
        messages,
      });
      return { text, provider: "gemini-free", model: "gemini-2.5-flash", neurons: 0 };
    } catch (e) {
      dailyQuota.fallbacks += 1;
      errors.push(`gemini: ${e.message}`);
    }
  }

  // 2. Cloudflare Workers AI keyless daily free allocation (10,000 Neurons/day)
  if (env?.AI && dailyQuota.neuronsUsed < budget) {
    const highUsage = dailyQuota.neuronsUsed > budget * 0.7;
    const cfModels = highUsage
      ? [
          "@cf/openai/gpt-oss-20b",
          "@cf/meta/llama-3.1-8b-instruct-fast",
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        ]
      : [
          "@cf/openai/gpt-oss-120b",
          "@cf/openai/gpt-oss-20b",
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          "@cf/meta/llama-3.1-8b-instruct-fast",
        ];

    for (const cm of cfModels) {
      try {
        const result = await env.AI.run(cm, { messages, max_tokens: 1500 });
        const text =
          (typeof result?.response === "string" && result.response.trim()) ||
          result?.choices?.[0]?.message?.content?.trim() ||
          "";
        if (!text) throw new Error("Empty Workers AI output");
        const neurons = estimateNeurons(cm, inputChars, text.length);
        dailyQuota.neuronsUsed += neurons;
        return { text, provider: "cloudflare-workers-ai", model: cm, neurons };
      } catch (e) {
        dailyQuota.fallbacks += 1;
        errors.push(`workers-ai/${cm}: ${e.message}`);
      }
    }
  }

  // 3. Keyless Pollinations OpenAI-compatible fallback
  try {
    const text = await callOpenAICompat({
      url: "https://text.pollinations.ai/openai",
      apiKey: "",
      model: "openai",
      messages,
      timeoutMs: 30000,
    });
    return { text, provider: "pollinations-free", model: "gpt-oss-20b", neurons: 0 };
  } catch (e) {
    dailyQuota.fallbacks += 1;
    errors.push(`pollinations: ${e.message}`);
  }

  throw new Error(`All free AI providers exhausted or rate-limited: ${errors.join(" | ")}`);
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

export default {
  async fetch(request, env) {
    resetQuotaIfNewDay();
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const budget = Number(env?.DAILY_NEURON_BUDGET || 9500);
    const maxRpm = Number(env?.RATE_LIMIT_RPM || 20);
    const ttlSec = Number(env?.CACHE_TTL_SECONDS || 3600);

    if (path === "/" || path === "/health") {
      return jsonResponse(
        {
          ok: true,
          service: "sam-content-agent",
          runtime: "cloudflare-workers-edge",
          default_agent: "seo-guide",
          quota: {
            day: dailyQuota.day,
            neuronsUsed: dailyQuota.neuronsUsed,
            neuronBudget: budget,
            neuronsRemaining: Math.max(0, budget - dailyQuota.neuronsUsed),
            requestsToday: dailyQuota.requests,
            cacheHitsToday: dailyQuota.cacheHits,
            fallbacksToday: dailyQuota.fallbacks,
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
      return jsonResponse(
        {
          model: env?.AI ? "@cf/openai/gpt-oss-120b" : "gpt-oss-20b",
          default_agent: "seo-guide",
          agent: agentMap,
          providers: [
            ...(env?.GROQ_API_KEY ? ["groq-free"] : []),
            ...(env?.GEMINI_API_KEY ? ["gemini-free"] : []),
            ...(env?.AI ? ["cloudflare-workers-ai"] : []),
            "pollinations-free",
          ],
          quota: {
            neuronsRemaining: Math.max(0, budget - dailyQuota.neuronsUsed),
            neuronBudget: budget,
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
          neuronsUsed: dailyQuota.neuronsUsed,
          neuronBudget: budget,
          neuronsRemaining: Math.max(0, budget - dailyQuota.neuronsUsed),
          requestsToday: dailyQuota.requests,
          cacheHitsToday: dailyQuota.cacheHits,
          fallbacksToday: dailyQuota.fallbacks,
        },
        200,
        request,
        env,
      );
    }

    if (path === "/analyze" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const content = String(body.content || "");
      const keyword = String(body.keyword || "");
      return jsonResponse(analyzeDraftContent(content, keyword), 200, request, env);
    }

    if (path === "/normalize" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      return jsonResponse(normalizeContent(String(body.content || "")), 200, request, env);
    }

    if (path === "/workspace" && request.method === "GET") {
      const files = {};
      for (const [k, v] of memoryWorkspace.entries()) files[k] = v;
      return jsonResponse({ files }, 200, request, env);
    }

    if (path === "/workspace/file" && request.method === "PUT") {
      const body = await request.json().catch(() => ({}));
      if (!body.path) return jsonResponse({ error: "Missing path" }, 400, request, env);
      const savedPath = await saveWorkspaceFile(String(body.path), String(body.content || ""), env);
      return jsonResponse({ ok: true, path: savedPath }, 200, request, env);
    }

    if (path === "/session" && request.method === "GET") {
      return jsonResponse([...memorySessions.values()], 200, request, env);
    }

    if (path === "/session" && request.method === "POST") {
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

    const sessionMsgMatch = path.match(/^\/session\/([^/]+)\/message$/);
    if (sessionMsgMatch && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      const rl = checkRateLimit(ip, maxRpm);
      if (!rl.allowed) {
        return jsonResponse(
          { error: `Rate limit exceeded (${maxRpm} req/min). Retry in ${rl.retryAfter}s.` },
          429,
          request,
          env,
          { "Retry-After": String(rl.retryAfter) },
        );
      }

      const sid = sessionMsgMatch[1];
      let session = memorySessions.get(sid);
      if (!session) {
        session = { id: sid, title: "SAM Session", createdAt: Date.now(), messages: [] };
        memorySessions.set(sid, session);
      }

      const body = await request.json().catch(() => ({}));
      const agentKey = AGENT_PROMPTS[body.agent] ? body.agent : "seo-guide";
      const agentDef = AGENT_PROMPTS[agentKey];
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
        JSON.stringify({ agent: agentKey, history: historySlice, prompt: userText }),
      );

      if (!noCache) {
        const cached = await cacheGet(cacheKey, env);
        if (cached) {
          dailyQuota.cacheHits += 1;
          return jsonResponse(cached.payload, 200, request, env, {
            "X-SAM-Cache": "HIT",
            "X-SAM-Provider": cached.provider,
            "X-SAM-Model": cached.model,
            "X-SAM-Neurons-Remaining": String(Math.max(0, budget - dailyQuota.neuronsUsed)),
          });
        }
      }

      const memorySummary = memoryWorkspace.get("MEMORY.md") || "";
      const messages = [
        { role: "system", content: `${agentDef.system}\n\nWorkspace Memory:\n${memorySummary.slice(0, 600)}` },
        ...historySlice,
        { role: "user", content: userText },
      ];

      try {
        const result = await runWithProviderFallback({ messages, env });
        const { cleaned, saved } = await extractAndSaveFiles(result.text, env);

        session.messages.push({ role: "user", content: userText });
        session.messages.push({ role: "assistant", content: cleaned });

        const payload = {
          info: {
            sessionID: sid,
            agent: agentKey,
            providerID: result.provider,
            modelID: result.model,
            neuronsUsed: result.neurons,
            savedFiles: saved,
          },
          parts: [{ type: "text", text: cleaned }],
        };

        await cacheSet(
          cacheKey,
          { payload, provider: result.provider, model: result.model },
          ttlSec,
          env,
        );

        return jsonResponse(payload, 200, request, env, {
          "X-SAM-Cache": "MISS",
          "X-SAM-Provider": result.provider,
          "X-SAM-Model": result.model,
          "X-SAM-Neurons-Remaining": String(Math.max(0, budget - dailyQuota.neuronsUsed)),
        });
      } catch (err) {
        return jsonResponse(
          { error: err.message || "Generation failed across providers" },
          503,
          request,
          env,
        );
      }
    }

    return jsonResponse({ error: "Not found", path }, 404, request, env);
  },
};
