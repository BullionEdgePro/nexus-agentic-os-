// The knowledge base has never been re-indexed on a schedule.
//
// Found on 2026-08-18 by the heartbeat table that was six hours old, which is
// the whole argument for migration 050 in one row:
//
//   knowledge-reindex   runs 2   failures 2   last_finished_at NULL
//   last_error: Query touched tenant-scoped table "knowledge_sources" with no
//               tenant context. Wrap it in withTenant(organizationId, ...) — or,
//               if it is deliberately cross-tenant, in withAllTenants("why", ...)
//
// `findStaleSources` sweeps every business by design and carried no context at
// all, so DB_TENANT_ASSERT=strict threw on every run. The assert was doing
// exactly its job; nothing was listening. The scheduler logged "Knowledge
// re-index scheduled (every 6h)" at boot and the failure happened six hours
// later, in a job whose only trace was a log line on a box whose logs were
// erased on every deploy.
//
// What it cost: every source's content is whatever it was when somebody last
// ingested it by hand. A page that has changed since is answered from the old
// copy — silently, with a citation. `broken-knowledge` could not have reported
// it either: that operator watches sources marked FAILED, and this job threw
// before it could mark one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const PROCESSOR = read("apps", "api", "src", "queue", "reindex-processor.ts");

/** Comments stripped: this file quotes the very calls it asserts about. */
const code = PROCESSOR.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, " ").replace(/^[ \t]*\/\/[^\n]*/gm, " ");

test("the sweep says why it is cross-tenant instead of having no context", () => {
  // withAllTenants demands a reason, which is what turns an unscoped query from
  // an oversight into a decision. The sweep genuinely is cross-tenant: its
  // point is to pick the twenty stalest sources ACROSS the platform, because
  // the free tier's quota is the constraint and a per-business loop would make
  // the bound meaningless.
  assert.match(code, /withAllTenants\(\s*\n?\s*"knowledge re-index: picks the stalest sources across every business"/);
  assert.match(code, /findStaleSources\(\{ olderThanHours: STALE_AFTER_HOURS, limit: SOURCES_PER_RUN \}\)/);

  // And it must not be left bare anywhere.
  assert.ok(
    !/^\s*const stale = await findStaleSources\(/m.test(code),
    "findStaleSources must not run without a declared scope"
  );
});

test("marking a source failed is scoped to the business that owns it", () => {
  // `markSourceFailed` takes a source id and no organization, so it inherits
  // whatever context happens to be open — which, in this job, was none. Both
  // call sites are wrapped: the unparseable-URI branch and the ingest-failure
  // branch. A source that cannot be marked failed is a source `broken-knowledge`
  // will never report.
  const wrapped = code.match(/withTenant\(source\.organizationId, \(\) =>\s*\n?\s*markSourceFailed\(/g) ?? [];
  assert.equal(wrapped.length, 2, "both markSourceFailed call sites must be scoped");
  assert.ok(
    !/^\s*(await |if \(source\) await )markSourceFailed\(/m.test(code),
    "no unscoped markSourceFailed"
  );
});

test("the heartbeat is what made this findable at all", () => {
  // Kept as an assertion rather than a comment: if the wrapper is ever removed,
  // this job goes back to failing where only an erased log would have said so.
  assert.match(PROCESSOR, /withJobHeartbeat\("knowledge-reindex"/);
});
