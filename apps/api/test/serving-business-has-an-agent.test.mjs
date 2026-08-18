// Seventeen hours of silence, caused by a query that returned zero rows.
//
// FOUND IN PRODUCTION on 2026-08-18, by the operator sweep rather than by
// anybody looking. At 17:27 on 17 August a customer picked option 2 from the
// triage menu. The worker log records both halves of what happened next:
//
//   {"routedTo":"juris-prime","matched":["triage reply"],"msg":"Conversation routed to business"}
//   {"organizationId":"c4b232dc-…","msg":"No active agent configured for organization"}
//
// juris-prime had an active agent the entire time. `agent_configs` is under RLS,
// all five businesses answer on Zipicka's number, and the reply path's
// transaction is scoped to the OWNER — so a read for the SERVING business
// matched nothing. Not an error: zero rows, which the caller correctly read as
// "this business has no agent" and returned on. Confirmed afterwards by reading
// it as nexus_app with app.current_org set to Zipicka: 0 rows.
//
// The blast radius is every customer the switchboard routes away from the
// number's owner, which is four of the five businesses.
//
// The same mistake has now been made four times — hasStaffOnShift ("you have no
// staff at all"), the phrase lookup, the stale-handoff release, and this. Every
// time it fails toward silence, and every time it looks like a business with
// nothing configured rather than a bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const SWITCHBOARD = read("packages", "agents", "src", "switchboard.ts");
const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");

/**
 * The agent-config loader, on its own.
 *
 * To the end of the file rather than to the next declaration: `toAgentConfig` is
 * declared ABOVE this function, so slicing to it produced an empty string and an
 * assertion that could only fail. Worth the sentence — a source-reading test
 * whose slice is wrong fails loudly here and would pass silently if the bounds
 * happened to include the whole file.
 */
const LOADER = SWITCHBOARD.slice(SWITCHBOARD.indexOf("async function loadActiveAgentConfig"));

test("the agent is read as the business that is answering, not the one that owns the number", () => {
  // Asserted as a POSITIVE and a NEGATIVE, because the version this replaces
  // would have passed any test that only checked the query text: the SQL was
  // always correct, and the scope it ran under was not.
  assert.match(LOADER, /withServingTenant\(organizationId/);
  assert.match(LOADER, /from agent_configs/);
  assert.ok(
    !/^\s*const \{ rows \} = await getPool\(\)\.query<AgentConfigRow>/m.test(LOADER) ||
      LOADER.indexOf("withServingTenant") < LOADER.indexOf("getPool()"),
    "the read must happen INSIDE the widened scope, not beside it"
  );
});

test("no agent is a real state, and the honest answer to it is not silence", () => {
  // This branch used to be `logger.warn(...); return;` — no reply, no fallback,
  // no handoff, and no metric row either, because it returns before the write.
  // The conversation then looked identical to one nobody had messaged.
  const branch = PROCESSOR.slice(
    PROCESSOR.indexOf("const agent = await routeToEmployeeTwin(serving, employee);"),
    PROCESSOR.indexOf("// Everything below is \"generate and deliver an AI reply\"")
  );

  assert.match(branch, /sendFallbackBestEffort\(/, "the customer must hear something");
  assert.match(branch, /recordMetricBestEffort\(/, "and it must be written down");

  // The same three-way distinction migration 049 introduced: a worse answer and
  // no answer at all are different rows.
  assert.match(branch, /replyOutcome: reached \? \("fallback" as const\) : \("none" as const\)/);
  assert.match(branch, /resolvedBy: "unresolved"/);
});

test("the four places this mistake has been made all read the serving business", () => {
  // Kept as one assertion rather than four files, because the value is in the
  // pattern: every one of these was written correctly for a single-tenant number
  // and is wrong for a shared one, and each was found only after it had already
  // cost something.
  for (const [what, source] of [
    ["the agent config", SWITCHBOARD],
    ["the authored phrase", PROCESSOR],
  ]) {
    assert.match(source, /withServingTenant\(/, `${what} must be read as the serving business`);
  }

  // hasStaffOnShift is the third and lives in its own module; the stale-handoff
  // release is the fourth and is pinned by stale-handoff-releases.test.mjs.
  const availability = read("apps", "api", "src", "services", "availability.ts");
  assert.match(availability, /withServingTenant\(/);
});
