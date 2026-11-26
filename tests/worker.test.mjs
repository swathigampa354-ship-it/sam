import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.mjs";

function makeReq(path, { method = "GET", body, ip = "203.0.113.10", extraHeaders = {} } = {}) {
  return new Request(`https://sam-content-agent.uberfor361.workers.dev${path}`, {
    method,
    headers: {
      Origin: "https://swathigampa354-ship-it.github.io",
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("worker /config exposes all 4 SAM agents and CORS headers", async () => {
  const res = await worker.fetch(makeReq("/config"), { AI: {} });
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("Access-Control-Allow-Origin"),
    "https://swathigampa354-ship-it.github.io",
  );
  const data = await res.json();
  assert.equal(data.default_agent, "seo-guide");
  assert.deepEqual(Object.keys(data.agent).sort(), [
    "article-writer",
    "fact-checker",
    "seo-guide",
    "seo-reviewer",
  ]);
});

test("worker /analyze and /normalize support both bold metadata colon styles", async () => {
  const normRes = await worker.fetch(
    makeReq("/normalize", {
      method: "POST",
      body: { content: "Hello\u200B world   \r\n\r\n\r\n\r\nNext" },
    }),
    {},
  );
  const norm = await normRes.json();
  assert.equal(norm.changes.invisibleCharactersRemoved, 1);
  assert.equal(norm.changes.lineEndingsNormalized, true);

  const anaRes = await worker.fetch(
    makeReq("/analyze", {
      method: "POST",
      body: {
        keyword: "saas onboarding",
        content: [
          "**Meta Title:** SaaS Onboarding Checklist",
          "**Meta Description:** Improve saas onboarding retention fast.",
          "**URL Slug:** saas-onboarding",
          "",
          "# SaaS Onboarding Checklist",
          "",
          "Great saas onboarding gets users to value in minutes.",
          "",
          "## Activation Milestones",
          "",
          "Keep setup steps short.",
        ].join("\n"),
      },
    }),
    {},
  );
  const ana = await anaRes.json();
  assert.equal(ana.structure.h1Count, 1);
  assert.equal(ana.structure.h2Count, 1);
  assert.equal(ana.keyword.inTitle, true);
  assert.equal(ana.keyword.inMetaTitle, true);
});

test("worker /session/:id/message handles provider fallback, workspace save, caching, rate limit, SSE stream, and hard quota stop + recovery", async () => {
  let callCount = 0;
  const mockEnv = {
    HARD_DAILY_NEURON_LIMIT: "9000",
    HARD_DAILY_REQUEST_LIMIT: "90000",
    RATE_LIMIT_RPM: "3",
    AI: {
      async run(model, opts) {
        callCount += 1;
        if (opts?.stream) {
          const enc = new TextEncoder();
          return new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(enc.encode('data: {"response":"# Streamed Title\\n\\n"}\n\n'));
              ctrl.enqueue(
                enc.encode(
                  'data: {"response":"Fast body.","usage":{"neurons":12.5}}\n\ndata: [DONE]\n\n',
                ),
              );
              ctrl.close();
            },
          });
        }
        if (model === "@cf/meta/llama-3.3-70b-instruct-fp8-fast") {
          throw new Error("Simulated primary model capacity limit");
        }
        return {
          response:
            '<sam-file path="drafts/test-post.md">**Meta Title**: Test Post\n**Meta Description**: Test desc\n**URL Slug**: test-post\n\n# Test Post\n\nBody text.\n\n## Section\n\nMore text.</sam-file>\n\nSaved draft.',
          usage: { neurons: 10.25 },
        };
      },
    },
  };

  const sRes = await worker.fetch(
    makeReq("/session", { method: "POST", body: { title: "E2E" }, ip: "198.51.100.5" }),
    mockEnv,
  );
  const session = await sRes.json();

  // First call: triggers fallback from llama-3.3-70b -> gpt-oss-20b, saves file, caches response
  const m1 = await worker.fetch(
    makeReq(`/session/${session.id}/message`, {
      method: "POST",
      ip: "198.51.100.5",
      body: {
        agent: "seo-guide",
        parts: [{ type: "text", text: "Write test post" }],
      },
    }),
    mockEnv,
  );
  assert.equal(m1.status, 200);
  assert.equal(m1.headers.get("X-SAM-Cache"), "MISS");
  assert.equal(m1.headers.get("X-SAM-Model"), "@cf/openai/gpt-oss-20b");
  assert.equal(m1.headers.get("X-SAM-Fallbacks"), "1");
  const body1 = await m1.json();
  assert.equal(body1.info.savedFiles[0].path, "drafts/test-post.md");
  const callsAfterFirst = callCount;
  assert.equal(callsAfterFirst, 2);

  // Cache HIT on fresh session with identical prompt
  const sRes2 = await worker.fetch(
    makeReq("/session", { method: "POST", body: { title: "E2E-cache" }, ip: "198.51.100.5" }),
    mockEnv,
  );
  const session2 = await sRes2.json();
  const m2 = await worker.fetch(
    makeReq(`/session/${session2.id}/message`, {
      method: "POST",
      ip: "198.51.100.5",
      body: {
        agent: "seo-guide",
        parts: [{ type: "text", text: "Write test post" }],
      },
    }),
    mockEnv,
  );
  assert.equal(m2.status, 200);
  assert.equal(m2.headers.get("X-SAM-Cache"), "HIT");
  assert.equal(callCount, callsAfterFirst);

  // SSE stream endpoint test
  const streamRes = await worker.fetch(
    makeReq(`/session/${session2.id}/stream`, {
      method: "POST",
      ip: "198.51.100.88",
      body: {
        agent: "article-writer",
        parts: [{ type: "text", text: "Stream quick outline" }],
      },
    }),
    mockEnv,
  );
  assert.equal(streamRes.status, 200);
  assert.ok(streamRes.headers.get("Content-Type").includes("text/event-stream"));
  const streamTxt = await streamRes.text();
  assert.ok(streamTxt.includes("# Streamed Title"));
  assert.ok(streamTxt.includes('"done":true'));

  // Hard quota exhaustion (cap lowered below current neuronsUsed + external disabled) -> HTTP 429 HARD_QUOTA_STOP
  const qExhaust = await worker.fetch(
    makeReq(`/session/${session2.id}/message`, {
      method: "POST",
      ip: "198.51.100.99",
      extraHeaders: {
        "X-SAM-Max-Neurons": "1",
        "X-SAM-Disable-External-Fallback": "1",
      },
      body: {
        agent: "seo-guide",
        noCache: true,
        parts: [{ type: "text", text: "Blocked when hard quota exhausted" }],
      },
    }),
    mockEnv,
  );
  assert.equal(qExhaust.status, 429);
  const qErr = await qExhaust.json();
  assert.equal(qErr.code, "HARD_QUOTA_STOP");

  // Immediate quota recovery once cap is restored (normal 9000 cap) -> HTTP 200
  const qRecover = await worker.fetch(
    makeReq(`/session/${session2.id}/message`, {
      method: "POST",
      ip: "198.51.100.99",
      body: {
        agent: "seo-guide",
        noCache: true,
        parts: [{ type: "text", text: "Recovers cleanly once quota window active" }],
      },
    }),
    mockEnv,
  );
  assert.equal(qRecover.status, 200);

  // Rate limit check (4th message in 1 minute from 198.51.100.5 -> 429)
  await worker.fetch(
    makeReq(`/session/${session2.id}/message`, {
      method: "POST",
      ip: "198.51.100.5",
      body: { agent: "seo-guide", parts: [{ type: "text", text: "Third prompt" }] },
    }),
    mockEnv,
  );
  const rlRes = await worker.fetch(
    makeReq(`/session/${session2.id}/message`, {
      method: "POST",
      ip: "198.51.100.5",
      body: { agent: "seo-guide", parts: [{ type: "text", text: "Fourth prompt" }] },
    }),
    mockEnv,
  );
  assert.equal(rlRes.status, 429);
  assert.ok(rlRes.headers.get("Retry-After"));
});
