// A finding nobody can act on teaches people to ignore findings.
//
// The deck is built on one rule: an empty list must not read as good news
// unless it IS good news. Production found the inverse. A test message the
// owner sent to the shared number has stood as an URGENT customer-waiting
// finding for twenty-seven hours; nobody will answer it, because there is no
// customer. Three more say three firms offer appointments with no staff, which
// may well be a decision already made.
//
// A list whose top entry is permanently urgent and permanently ignorable
// trains its reader to skip the top entry, which is worse than no list. That is
// the same disease the retract half of reconciliation exists to prevent,
// arriving through a door reconciliation cannot close -- these findings are
// TRUE. They are just accepted.
//
// THE CORRECTNESS QUESTION IS THE LIFETIME. "I have accepted this" is about the
// occurrence somebody looked at, not about the fingerprint forever. Accepting
// that three firms have no staff today must not silence the same finding next
// March, when it would mean something different. Get this wrong and dismissal
// is a permanent silent mute that looks like a working feature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const DB = read("packages", "db", "src", "operators.ts");
const MIGRATION = read(
  "packages",
  "db",
  "migrations",
  "061-a-finding-somebody-has-accepted.sql"
);
const ROUTE = read("apps", "api", "src", "routes", "operators.ts");
const PAGE = read("apps", "web", "app", "deck", "operators", "page.tsx");

/** The body of the upsert's `do update set`, where the lifetime is decided. */
function upsertSet() {
  const from = DB.indexOf("on conflict (organization_id, operator, fingerprint) do update set");
  const to = DB.indexOf("returning organization_id", from);
  assert.ok(from > -1 && to > from, "could not find the upsert");
  return DB.slice(from, to);
}

test("a dismissal lapses under the same predicate that resets the age", () => {
  // THIS IS THE TEST THIS FILE EXISTS FOR.
  //
  // reconcileFindings already resets first_seen_at when a finding returns from
  // resolved, because a problem that came back yesterday must not be reported
  // as three weeks old. A dismissal has exactly that lifetime. Tying them to
  // the same predicate is what makes them impossible to drift apart -- and if
  // somebody edits one branch and not the other, the result is a permanent
  // mute that no other test would notice.
  const body = upsertSet();

  const branches = [...body.matchAll(/(\w+)\s*=\s*case\s*\n\s*--[\s\S]*?when operator_findings\.resolved_at is not null then (\S+)/g)]
    .map((m) => [m[1], m[2]]);
  const simple = [...body.matchAll(/(\w+)\s*=\s*case\s*\n\s*when operator_findings\.resolved_at is not null then (\S+)/g)]
    .map((m) => [m[1], m[2]]);
  const all = new Map([...branches, ...simple]);

  assert.equal(
    all.get("first_seen_at"),
    "now()",
    "the age no longer resets when a finding returns -- this test's premise is gone"
  );
  assert.equal(
    all.get("dismissed_at"),
    "null",
    "a dismissal must lapse when the finding returns, or accepting it once mutes it forever"
  );
  assert.equal(all.get("dismissed_by"), "null", "the acceptor must be cleared with the acceptance");
});

test("the sweep can clear a dismissal and can never create one", () => {
  // An operator retracts; only a person accepts. If reconciliation could write
  // a timestamp into dismissed_at, a bug in an operator could silence itself.
  const body = upsertSet();
  const writes = [...body.matchAll(/dismissed_at\s*=\s*([\s\S]*?)(?=,\n\s{9}\w|$)/g)].map((m) => m[1]);
  assert.equal(writes.length, 1, "dismissed_at is written more than once in the upsert");
  assert.ok(
    !/then now\(\)/.test(writes[0]),
    "the sweep must never set a dismissal, only clear one"
  );
});

test("an accepted finding does not raise an alert", () => {
  // `raised` is the transition the dispatcher sends on. Telling somebody about
  // a finding they accepted thirty seconds ago is how the dispatcher gets
  // muted at the firewall.
  assert.match(DB, /first_seen_at = last_seen_at and dismissed_at is null\) as newly_raised/);
});

test("dismissal is not deletion", () => {
  // Deleting the row would let the next sweep INSERT it fresh: first_seen_at =
  // now(), which the reconciler reads as a transition, and the dispatcher would
  // alert on a finding somebody had just dismissed.
  assert.ok(
    !/delete\s+from\s+operator_findings/i.test(DB),
    "findings must never be deleted -- the next sweep would re-raise them as new"
  );
  assert.match(DB, /update operator_findings\n\s+set dismissed_at/);
});

test("the counts exclude accepted findings but still report them", () => {
  // A badge that still reads "1 urgent" after somebody accepted the only urgent
  // finding can never be cleared, and an unclearable badge is ignored inside a
  // week. Dropping them instead would make the page silently aware of problems
  // it is not mentioning, which is the failure it exists to prevent.
  assert.match(DB, /filter \(where severity = 'urgent' and dismissed_at is null\)/);
  assert.match(DB, /filter \(where dismissed_at is not null\)\s*::text\s*as dismissed/);
});

test("the write authorises on the business and runs in the owner", () => {
  // A finding about Juris Prime's customer is a ROW UNDER ZIPICKA, because all
  // five firms answer on Zipicka's number. RLS filters organization_id, so an
  // update in Juris Prime's transaction matches zero rows AND REPORTS SUCCESS:
  // the button greys out, the finding stays, nothing says why. That is instance
  // ten of the defect this codebase has met nine times.
  assert.match(ROUTE, /finding\.businessId === scope\.organizationId/);
  assert.match(ROUTE, /withServingTenant\(finding\.organizationId/);

  // And the update itself must filter on the owning column, never the resolved
  // one, or the widening above is undone in SQL.
  const update = DB.slice(DB.indexOf("update operator_findings\n        set dismissed_at"));
  const where = update.slice(update.indexOf("where"), update.indexOf("[findingId"));
  assert.ok(
    !/coalesce\(serving_organization_id/.test(where),
    "the update must filter on organization_id, which is what RLS enforces"
  );
});

test("an unauthorised dismissal is indistinguishable from a missing one", () => {
  // Two different messages would let somebody enumerate which finding ids exist
  // under businesses they cannot see.
  const handler = ROUTE.slice(ROUTE.indexOf("async function handleDismissal"));
  const guard = handler.slice(0, handler.indexOf("withServingTenant"));
  assert.equal(
    (guard.match(/Finding not found/g) ?? []).length,
    2,
    "the not-found and not-yours paths must return the same message"
  );
});

test("the empty list says when it is empty only because things were accepted", () => {
  // "Nothing needs attention" is TRUE when everything left is accepted, and on
  // its own it is a half-truth -- which is the single failure this page was
  // built to prevent, restated.
  const clear = PAGE.slice(PAGE.indexOf("Nothing needs attention"));
  const branch = clear.slice(0, clear.indexOf("</div>"));
  assert.match(branch, /counts\.dismissed > 0/);
  assert.match(branch, /still true and w(as|ere) accepted/);
});

test("accepted findings are collapsed, never hidden", () => {
  // The count is always on screen; only the detail folds away. A screen that
  // quietly drops findings somebody accepted last March is how an accepted
  // problem becomes a forgotten one.
  assert.match(PAGE, /accepted finding/);
  const section = PAGE.slice(PAGE.indexOf('className="op-dismissed"'));
  const toggle = section.slice(0, section.indexOf("</section>"));
  assert.match(toggle, /dismissed\.length === 1/, "the count renders outside the expanded state");
  assert.match(toggle, /showDismissed \?/, "only the detail is behind the toggle");
});

test("who accepted it is shown", () => {
  // An anonymous dismissal is an invitation to accept things nobody will answer
  // for.
  assert.match(PAGE, /accepted by \{?finding\.dismissedBy|accepted by/);
  assert.match(MIGRATION, /dismissed_by/);
});

test("the truncation banner compares like with like", () => {
  // `total` counts what needs attention; the list carries accepted findings
  // too. Comparing against findings.length would count the accepted ones on one
  // side of the inequality and not the other, and the banner would stop
  // appearing at exactly the moment the cap started biting.
  assert.match(PAGE, /total > active\.length/);
  assert.ok(
    !/total > findings\.length/.test(PAGE),
    "the cap banner is comparing a filtered count against an unfiltered list"
  );
});
