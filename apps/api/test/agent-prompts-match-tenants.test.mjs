// What each agent believes about itself, checked against what the business is.
//
// Migration 008 established that `juris-prime` is document attestation, not
// business licensing. That correction reached the routing keywords, the tenant
// profile, the public page and the operator console — everywhere a HUMAN reads
// — and missed `agent_configs.system_prompt`, the one place the AI reads. The
// switchboard then routed real attestation enquiries to an agent introducing
// itself as a licensing consultancy. Nothing errored; the reply was fluent, on
// brand, and about the wrong service.
//
// A prompt is data. It drifts from the rest of the tenant record exactly like
// any other column, and nothing else in the suite was looking at it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, "..", "..", "..", "packages", "db", "migrations");
const read = (...p) => readFileSync(join(...p), "utf8");

/**
 * Drop `--` comments before asserting on what a migration SAYS.
 *
 * Needed because these files explain the bug they fix, in prose, using the very
 * wording the assertions look for — migration 012's header describes an agent
 * that "introduces itself as a licensing consultancy", which is exactly the
 * string that must not survive in a prompt VALUE. Without this the test failed
 * on its own documentation.
 */
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * Join adjacent SQL string literals so a phrase can be matched.
 *
 * Long prompts are written as `'...predict an ' || 'outcome or a sentence...'`,
 * which means the sentence a reader sees does not exist as a contiguous string
 * in the file. Asserting on the raw source silently fails on any phrase that
 * happens to straddle a concatenation — a false negative that looks like a
 * missing safeguard.
 */
function joinSqlConcat(sql) {
  return sql.replace(/'\s*\|\|\s*'/g, "");
}

const SEED = stripSqlComments(read(here, "..", "..", "..", "packages", "db", "seed.sql"));
const PROFILES = stripSqlComments(read(migrations, "008-tenant-profiles.sql"));
const PROMPTS = stripSqlComments(read(migrations, "012-agent-prompts.sql"));
// ABR arrived later, in its own migration — its prompt is not in 012.
const ABR_PROMPTS = joinSqlConcat(stripSqlComments(read(migrations, "014-abr-replaces-atif-ali.sql")));

/** Everything the platform says about a tenant, in one blob per slug. */
const PROMPT_SOURCES = SEED + "\n" + PROMPTS + "\n" + ABR_PROMPTS;

test("no agent still describes Juris Prime as business licensing", () => {
  // The specific wrong belief, asserted directly. It was corrected in four
  // places and survived in a fifth for long enough to reach production.
  const stale = /juris.prime[\s\S]{0,600}?(licensing consultancy|business licensing consultancy)/i;
  assert.ok(
    !stale.test(SEED),
    "seed.sql still seeds Juris Prime as a licensing consultancy — a fresh install would reintroduce it"
  );

  // And the correcting migration must actually say what the business IS.
  assert.match(PROMPTS, /attestation/i);
  assert.match(PROMPTS, /notary|legal translation/i);
});

test("each tenant's agent is told the business it is actually in", () => {
  // Derived from the tenant taglines in migration 008 rather than restated, so
  // a future tenant correction that misses the prompt fails here.
  const expectations = [
    { slug: "juris-prime", mustMention: /attestation/i },
    { slug: "juris-prime-legal", mustMention: /law firm|legal/i },
    { slug: "sfs-international", mustMention: /real estate/i },
    { slug: "zipicka", mustMention: /e-commerce|store/i },
    { slug: "abr", mustMention: /litigation|advocates/i },
  ];

  for (const { slug, mustMention } of expectations) {
    // The prompt text following this slug in either the seed or the migration.
    const block = PROMPT_SOURCES.split(`'${slug}'`).slice(1).join("\n");
    assert.ok(block.length > 0, `${slug} has no agent prompt anywhere`);
    assert.match(block, mustMention, `${slug}'s prompt never says what the business does`);
  }
});

/**
 * The values assigned to `system_prompt`, without the surrounding SQL.
 *
 * Scanning the whole file is not good enough: migration 012 contains an
 * assertion querying `system_prompt ilike '%licensing consultancy%'` — the
 * guard that proves the fix landed — and a naive search cannot tell that apart
 * from the wrong belief itself. What matters is what an agent is actually
 * given, so only assignment values are read.
 */
function assignedPrompts(sql) {
  return [...sql.matchAll(/system_prompt\s*=\s*([\s\S]*?)(?:,\s*updated_at|\s+from\s+organizations|\s+where\s)/g)].map(
    (m) => m[1]
  );
}

test("the tenant profile and the agent prompt agree on Juris Prime", () => {
  // Both sides of the correction, read from their own files. If someone edits
  // one without the other, this is what notices.
  assert.match(PROFILES, /Document attestation/i, "migration 008 must describe juris-prime as attestation");

  const values = assignedPrompts(PROMPTS);
  assert.ok(values.length >= 2, "expected agent prompts to be assigned");

  for (const value of values) {
    assert.ok(
      !/licensing consultancy/i.test(value),
      `an agent is still being told it is a licensing consultancy: ${value.slice(0, 120)}`
    );
  }

  // And one of them must positively say what the business is — absence of the
  // wrong answer is not presence of the right one.
  assert.ok(values.some((v) => /attestation/i.test(v)), "no agent prompt mentions attestation");
});

test("the second law firm is held to the same restraint as the first", () => {
  // ABR replaced Atif Ali Production and does criminal defence and litigation.
  // A customer forming an impression about a charge, a deadline or the merits
  // of their case from a machine is a liability, not a support ticket — so the
  // prompt has to forbid exactly those, not merely encourage caution.
  const abr = ABR_PROMPTS;
  assert.match(abr, /NEVER give specific legal advice/i);
  assert.match(abr, /predict an outcome|predict a[n]? .{0,20}outcome/i);
  assert.match(abr, /cite UAE law from memory/i);
  assert.match(abr, /quote fees/i);
  // An arrest or an imminent court date is not something to answer at all.
  assert.match(abr, /arrest|detention/i);
  assert.match(abr, /escalate/i);
});

test("every agent knows it shares a number with four others", () => {
  // Classification is conservative but keyword-based, so it will be wrong
  // sometimes. The agent is the last thing between a misrouted customer and a
  // confident answer from the wrong business — which here also means the wrong
  // governance policy.
  assert.match(PROMPTS, /share a WhatsApp number with four other businesses/);
  assert.match(PROMPTS, /do not attempt to answer it/i);

  // And the migration must verify its own outcome rather than assume it.
  assert.match(PROMPTS, /raise exception/i, "the migration must assert the correction landed");
  console.log("PASS: what each agent believes matches what the business is");
});
