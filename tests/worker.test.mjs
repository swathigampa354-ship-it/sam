import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.mjs";

function makeReq(path, { method = "GET", body, ip = "203.0.113.10" } = {}) {
  return new Request(`https://sam.workers.dev${path}`, {
    method,
    headers: {
      Origin: "https://swathigampa354-ship-it.github.io",
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
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

test("worker /analyze and /normalize run full SAM deterministic pipeline", async () => {
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
          "**Meta Title**: SaaS Onboarding Checklist",
          "**Meta Description**: Improve saas onboarding retention fast.",
          "**URL Slug**: saas-onboarding",
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

test("worker /session/:id/message handles provider fallback, workspace save, caching, and rate limit", async () => {
  let callCount = 0;
  const mockEnv = {
    DAILY_NEURON_BUDGET: "9500",
    RATE_LIMIT_RPM: "3",
    AI: {
      async run(model) {
        callCount += 1;
        if (model === "@cf/openai/gpt-oss-120b") {
          throw new Error("Simulated model capacity limit");
        }
        return {
          response:
            '<sam-file path="drafts/test-post.md">**Meta Title**: Test Post\n**Meta Description**: Test desc\n**URL Slug**: test-post\n\n# Test Post\n\nBody text.\n\n## Section\n\nMore text.</sam-file>\n\nSaved draft.',
        };
      },
    },
  };

  const sRes = await worker.fetch(
    makeReq("/session", { method: "POST", body: { title: "E2E" }, ip: "198.51.100.5" }),
    mockEnv,
  );
  const session = await sRes.json();

  // First call: triggers fallback from 120b -> 20b, saves file, caches response
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
  const body1 = await m1.json();
  assert.equal(body1.info.savedFiles[0].path, "drafts/test-post.md");
  const callsAfterFirst = callCount;
  assert.equal(callsAfterFirst, 2); // 1 failed + 1 succeeded

  // Second identical call (same context? Note session history grew so test fresh session for exact cache hit)
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
  assert.equal(callCount, callsAfterFirst); // 0 new LLM calls on cache HIT

  // Workspace file persisted
  const wsRes = await worker.fetch(makeReq("/workspace"), mockEnv);
  const ws = await wsRes.json();
  assert.ok(ws.files["drafts/test-post.md"].includes("# Test Post"));

  // Rate limit check (4th message in 1 minute from same IP with RATE_LIMIT_RPM=3 -> 429)
  await worker.fetch(
    makeReq(`/session/${session2.id}/message`, {
      method: "POST",
      ip: "198.51.100.5",
      body: { agent: "seo-guide", parts: [{ type: "text", text: "Another prompt" }] },
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
