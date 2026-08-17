// The knowledge base was readable the whole time nobody could read it.
//
// Retrieval has one external dependency — Google's embedding endpoint — and no
// way round it. It has gone away twice: a 503 run on 15 August, and a connect
// timeout that aborted self-check. Both times every customer was told a
// colleague would confirm, while the answer sat in knowledge_chunks.content as
// plain text that nothing was willing to read without a vector.
//
// Migration 047 and these tests are the fallback. What is being pinned here is
// mostly the FENCING rather than the feature: a weaker matcher wired in beside
// the real one, or reporting itself as healthy, would each be worse than the
// outage it mitigates.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { worstRetrievalOutcome } from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const RETRIEVE = read("packages", "knowledge", "src", "retrieve.ts");
const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const MIGRATION = read("packages", "db", "migrations", "047-lexical-fallback.sql");

/**
 * Both search paths, stubbed once and rebound per test.
 *
 * `mock.module` refuses to mock the same specifier twice in a process, so the
 * stubs close over mutable state rather than being re-registered. Each records
 * its calls, because the most important assertion in this file is a NEGATIVE one
 * — that the fallback did not run — and a stub that only returns cannot express
 * it.
 */
const impl = { semantic: async () => [], lexical: async () => [] };
const calls = { semantic: 0, lexical: 0 };

mock.module("@nexus/knowledge", {
  namedExports: {
    searchKnowledge: async (input) => {
      calls.semantic += 1;
      return impl.semantic(input);
    },
    searchKnowledgeLexical: async (input) => {
      calls.lexical += 1;
      return impl.lexical(input);
    },
  },
});

const { searchKnowledgeTool: tool } = await import(
  "../../../packages/agents/src/tools/knowledge.ts"
);

function given({ semantic, lexical }) {
  impl.semantic = semantic;
  impl.lexical = lexical;
  calls.semantic = 0;
  calls.lexical = 0;
}

const CTX = { organizationId: "org-1", employeeId: null };
const hit = (content, title) => ({
  content,
  score: 0.4,
  mode: "lexical",
  sourceTitle: title,
  sourceUri: `https://example.com/${title}`,
  chunkIndex: 0,
  lastIndexedAt: "2026-08-01T00:00:00Z",
});

test("a miss is a refusal, and the fallback never sees it", async () => {
  // The one that matters most. DEFAULT_MIN_SCORE exists so the agent is not
  // handed noise to paraphrase; retrying a miss with a weaker matcher would
  // convert a designed "we have nothing on that" into "here is a page sharing a
  // noun with your question", which is the failure the floor was set to prevent.
  given({
    semantic: async () => [],
    lexical: async () => [hit("anything at all", "wrong-page")],
  });

  const out = await tool.handler({ query: "do you do criminal defence?" }, CTX);

  assert.equal(out.outcome, "miss");
  assert.equal(out.found, false);
  assert.equal(calls.lexical, 0, "a miss must not reach the keyword fallback");
});

test("when the provider is down, Postgres answers — and says that is what it is", async () => {
  given({
    semantic: async () => {
      throw new Error("getaddrinfo ENOTFOUND generativelanguage.googleapis.com");
    },
    lexical: async () => [hit("We handle criminal defence matters.", "criminal-law")],
  });

  const out = await tool.handler({ query: "do you do criminal defence?" }, CTX);

  assert.equal(calls.lexical, 1);
  assert.equal(out.found, true);

  // NOT 'hit'. A degraded reply recorded as a healthy one hides the outage
  // inside its own mitigation, and retrieval-unavailable sweeps on this value.
  assert.equal(out.outcome, "degraded");
  assert.equal(out.degraded, true);

  // The excerpt must arrive labelled. This is the real guard on the feature:
  // keyword search returns a confidently wrong page often enough to matter and
  // no score threshold catches it, so the model is told what it is holding.
  assert.equal(out.results[0].match, "keyword");
  assert.equal(
    out.results[0].relevance,
    undefined,
    "a ts_rank_cd must not be printed under the name the cosine score uses"
  );
  assert.match(out.note, /not meaning/i);
  assert.match(out.note, /colleague will confirm/i);
});

test("both paths down is still the honest deferral it always was", async () => {
  for (const lexical of [async () => [], async () => { throw new Error("db gone"); }]) {
    given({
      semantic: async () => { throw new Error("timeout"); },
      lexical,
    });
    const out = await tool.handler({ query: "anything" }, CTX);
    assert.equal(out.outcome, "failed");
    assert.equal(out.found, false);
  }
});

test("the fallback cannot see one row more than the real search", () => {
  // A fallback with its own hand-written where clause would be a tenant
  // isolation hole reachable only during a provider outage — the least-tested
  // moment this system has. So the visibility rules are one constant that both
  // queries interpolate, and this asserts neither has grown its own copy.
  const employeeFilters = RETRIEVE.match(/c\.employee_id = \$/g) ?? [];
  assert.equal(
    employeeFilters.length,
    1,
    "the employee visibility rule must exist exactly once, inside VISIBILITY_SQL"
  );

  const orgFilters = RETRIEVE.match(/c\.organization_id = \$/g) ?? [];
  assert.equal(orgFilters.length, 1, "the tenant filter must exist exactly once");

  const interpolations = RETRIEVE.match(/\$\{VISIBILITY_SQL\}/g) ?? [];
  assert.equal(interpolations.length, 2, "both search paths must use it");
});

test("the customer's message never becomes tsquery syntax", () => {
  // The disjunction is built inside SQL from to_tsvector's own lexemes, each one
  // quote_literal'd. Concatenating a WhatsApp message into to_tsquery would turn
  // an ampersand or a bracket into a syntax error at best.
  assert.match(RETRIEVE, /quote_literal\(lexeme\)/);
  assert.ok(
    !/to_tsquery\('english',\s*\$\d/.test(RETRIEVE),
    "the raw query text must never be handed to to_tsquery"
  );
});

test("worst wins, and degraded sits between failed and hit", () => {
  assert.equal(worstRetrievalOutcome([]), null);
  assert.equal(worstRetrievalOutcome(["hit"]), "hit");
  assert.equal(worstRetrievalOutcome(["miss"]), "miss");
  assert.equal(worstRetrievalOutcome(["degraded"]), "degraded");

  // A reply built on one healthy lookup and one keyword lookup is not healthy.
  assert.equal(worstRetrievalOutcome(["hit", "degraded"]), "degraded");
  // And one that deflected on any lookup outranks both.
  assert.equal(worstRetrievalOutcome(["hit", "degraded", "failed"]), "failed");
  // A miss alongside a degraded is still degraded — the outage is the fact.
  assert.equal(worstRetrievalOutcome(["miss", "degraded"]), "degraded");
});

test("the mitigation does not switch off the alarm it was written for", () => {
  // The trap this feature sets for itself: replies stop being recorded as
  // 'failed' precisely because the fallback caught them, so an operator
  // sweeping for 'failed' alone would report an outage as over the moment it
  // started being handled.
  const operator = OPERATORS.slice(
    OPERATORS.indexOf("const retrievalUnavailable"),
    OPERATORS.indexOf("const retrievalUnavailable") + 4000
  );
  assert.match(operator, /retrieval_outcome = 'degraded'/);
  assert.match(operator, /retrieval_outcome = 'failed'/);

  // Degraded-only is a warning, not silence: the customers were answered, but
  // from keyword matches nobody has read, on a provider that will not fix
  // itself.
  assert.match(operator, /severity: deflected \? \("urgent" as const\) : \("warn" as const\)/);
});

test("the index and the constraint moved together with the code", () => {
  // The check constraint is dropped BY NAME and re-added. If the name were
  // wrong the drop would silently do nothing, the add would create a second
  // constraint, and the original would go on rejecting every degraded row —
  // which surfaces as replies vanishing from the metrics, not as an error here.
  assert.match(MIGRATION, /drop constraint if exists conversation_metrics_retrieval_outcome_check/);
  assert.match(MIGRATION, /retrieval_outcome in \('hit', 'miss', 'failed', 'degraded'\)/);

  // 038's partial index covered 'failed' alone, which was the complete set of
  // unhealthy states on the day it was written and is not any more.
  assert.match(MIGRATION, /where retrieval_outcome in \('failed', 'degraded'\)/);
  assert.match(MIGRATION, /drop index if exists conversation_metrics_retrieval_failed_idx/);

  // The fallback reads this index on every call during an outage. Without it
  // the query still works, which is why its absence would never be noticed.
  assert.match(MIGRATION, /using gin \(to_tsvector\('english', content\)\)/);
});
