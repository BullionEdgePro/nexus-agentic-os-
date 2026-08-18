// Route tests for knowledge management. These endpoints fetch arbitrary URLs
// and write into what the agent later quotes to customers, so the guard rails
// matter more than the happy path: an unauthenticated or cross-tenant caller
// could poison a business's answers.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const calls = { ingestUrl: [], ingestText: [], deleted: [] };

class UnsafeUrlError extends Error {}

mock.module("@nexus/db", {
  exports: {
    // Added when delivery receipts landed (migration 048). These mocks stub
    // @nexus/db by ENUMERATION, so an export the processor imports and this
    // object omits is a module-load failure rather than a wrong answer — which
    // is how it should be, and is why this line exists rather than a spread.
    //
    // Returns false: none of these fixtures involves a status webhook, and
    // "nothing moved" is the honest answer for a receipt that never arrived.
    recordDeliveryStatus: async () => false,
    // Added with migration 051. Every delivery receipt is now tried against
    // broadcast_recipients as well as messages, because a wamid belongs to one
    // table or the other and the handler cannot tell which without asking.
    // These mocks stub @nexus/db by ENUMERATION, so a missing export is a
    // module-load failure rather than a wrong answer.
    recordBroadcastDelivery: async () => false,
    findOrganizationBySlug: async (slug) =>
      slug === "zipicka" ? { id: "org-1", slug: "zipicka", name: "Zipicka" } : null,
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
  },
});

mock.module("@nexus/knowledge", {
  exports: {
    UnsafeUrlError,
    listKnowledgeSources: async () => [
      { id: "src-1", kind: "url", title: "Shipping policy", uri: "https://x.test/s",
        status: "indexed", version: 2, chunks: 3, lastIndexedAt: "now", lastCheckedAt: "now", error: null },
    ],
    ingestUrlSource: async (input) => {
      calls.ingestUrl.push(input);
      if (input.url.includes("169.254")) throw new UnsafeUrlError("Refusing to fetch private address");
      if (input.url.includes("boom")) throw new Error("HTTP 500 fetching x.test");
      return { sourceId: "src-9", chunks: 4, skipped: false };
    },
    ingestTextSource: async (input) => {
      calls.ingestText.push(input);
      return { sourceId: "src-10", chunks: 1, skipped: false };
    },
    deleteKnowledgeSource: async (orgId, id) => {
      calls.deleted.push({ orgId, id });
      return id === "src-1";
    },
  },
});

mock.module(new URL("../src/lib/logger.ts", import.meta.url), {
  exports: { logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } },
});

const { knowledgeRoute } = await import("../src/routes/knowledge.ts");

const json = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("listing returns source health, not just titles", async () => {
  // "Is it indexed", "why did it fail", "how stale is it" are the questions an
  // operator actually has; a bare list makes a broken source look fine.
  const res = await knowledgeRoute.request("/zipicka/knowledge");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sources[0].status, "indexed");
  assert.equal(body.sources[0].chunks, 3);
  assert.ok("error" in body.sources[0] && "lastIndexedAt" in body.sources[0]);
});

test("an unknown organization is 404, not an empty list", async () => {
  const res = await knowledgeRoute.request("/not-a-tenant/knowledge");
  assert.equal(res.status, 404);
});

test("a URL source is ingested and reports its chunk count", async () => {
  const res = await knowledgeRoute.request("/zipicka/knowledge", json({ url: "https://x.test/page" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.chunks, 4);
  assert.equal(body.unchanged, false);
  assert.equal(calls.ingestUrl.at(-1).organizationId, "org-1", "must be scoped to the resolved tenant");
});

test("a blocked URL is the caller's mistake — 400 with the reason, not a 502", async () => {
  // An operator who pastes an internal address should learn why it was refused.
  const res = await knowledgeRoute.request(
    "/zipicka/knowledge",
    json({ url: "http://169.254.169.254/latest/meta-data/" })
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /private address/);
});

test("an upstream fetch failure is a 502, distinguishing it from bad input", async () => {
  const res = await knowledgeRoute.request("/zipicka/knowledge", json({ url: "https://boom.test/x" }));
  assert.equal(res.status, 502);
});

test("raw content requires a title", async () => {
  const res = await knowledgeRoute.request("/zipicka/knowledge", json({ content: "Some policy text" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /title/i);
});

test("an empty request is rejected rather than creating a blank source", async () => {
  const res = await knowledgeRoute.request("/zipicka/knowledge", json({}));
  assert.equal(res.status, 400);
});

test("malformed JSON is a 400, not a crash", async () => {
  const res = await knowledgeRoute.request("/zipicka/knowledge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("unchanged content is reported as unchanged, not as a failure", async () => {
  // Re-adding an identical page skips re-embedding. Reporting "0 chunks" alone
  // would look broken; `unchanged` says what actually happened.
  const restore = calls.ingestUrl.length;
  const res = await knowledgeRoute.request("/zipicka/knowledge", json({ url: "https://x.test/same" }));
  assert.equal(res.status, 200);
  assert.ok(calls.ingestUrl.length > restore);
});

test("deletion is scoped to the tenant, and a miss is a 404", async () => {
  // An operator sees every tenant today, so an id-only lookup would let a
  // mistyped request delete another business's knowledge.
  const ok = await knowledgeRoute.request("/zipicka/knowledge/src-1", { method: "DELETE" });
  assert.equal(ok.status, 200);
  assert.equal(calls.deleted.at(-1).orgId, "org-1");

  const miss = await knowledgeRoute.request("/zipicka/knowledge/nope", { method: "DELETE" });
  assert.equal(miss.status, 404, "a no-op delete must not report success");
  console.log("PASS: knowledge routes are tenant-scoped and separate bad input from upstream failure");
});
