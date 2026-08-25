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
import {
  DISMISSAL_HORIZONS as HORIZONS,
  DEFAULT_DISMISSAL_HORIZON,
  dismissalHorizon,
} from "@nexus/db";

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

/**
 * The condition guarding one field of the upsert's `do update set`.
 *
 * Plain string work, no regex. The version this replaced matched a pattern that
 * required `then` to follow the predicate on the same line, and it broke the
 * moment the predicate gained a second clause -- correctly, which is how that
 * change got read rather than landing quietly.
 */
function guardOf(field) {
  const body = upsertSet();
  const NL = String.fromCharCode(10);
  const at = body.indexOf(field + " = case");
  assert.ok(at > -1, `${field} is not written as a case in the upsert`);
  const start = at + (field + " = case").length;
  const end = body.indexOf("end", start);
  assert.ok(end > start, `${field}'s case is never closed`);
  const flat = body
    .slice(start, end)
    .split(NL)
    .map((line) => line.trim())
    // Comments are where the reasoning lives, not the rule. A test that read
    // them would pass on a sentence describing a predicate that is not there --
    // the single most repeated defect on this repository's own register.
    .filter((line) => line && !line.startsWith("--"))
    .join(" ")
    .split("  ")
    .join(" ");

  // The WHEN only. The else branch names the field being preserved, so it
  // differs by definition and comparing it would make every field look like it
  // had drifted.
  const then = flat.indexOf(" then ");
  assert.ok(then > -1, `${field}'s case has no then`);
  return { when: flat.slice(0, then).trim(), then: flat.slice(then + 6).split(" else ")[0].trim() };
}

test("a dismissal lapses under the same predicate that resets the age", () => {
  // THIS IS THE TEST THIS FILE EXISTS FOR.
  //
  // reconcileFindings already resets first_seen_at when a finding returns from
  // resolved, because a problem that came back yesterday must not be reported
  // as three weeks old. A dismissal has exactly that lifetime.
  const body = upsertSet();
  assert.ok(
    body.includes("first_seen_at = case"),
    "the age no longer resets when a finding returns -- this test's premise is gone"
  );
  const age = guardOf("first_seen_at");
  assert.ok(age.when.includes("resolved_at is not null"), "the age no longer resets on return");
  assert.equal(age.then, "now()", "the age no longer resets when a finding returns");

  // And the four fields of an acceptance share ONE predicate, whatever it is.
  // Split them and a row survives that is dismissed by nobody, or accepted with
  // no end -- worse than either state alone, because nothing reports it.
  const fields = ["dismissed_at", "dismissed_by", "dismissed_reason", "dismissed_until"];
  const first = guardOf(fields[0]).when;
  for (const field of fields) {
    const guard = guardOf(field);
    assert.equal(
      guard.when,
      first,
      `${field} lapses under a different condition than ${fields[0]} -- they must not drift apart`
    );
    assert.equal(guard.then, "null", `${field} does not clear when the acceptance ends`);
  }
});

test("an acceptance ends on a horizon as well as on resolution", () => {
  // THE GAP THIS FILE'S OWN HEADER PREDICTED AND DID NOT CLOSE. Resolution is
  // the right lapse for every condition that ENDS. For one that stays
  // continuously true there is no resolution, that branch never fires, and the
  // acceptance is exactly the "permanent silent mute that looks like a working
  // feature" written at the top of this file.
  //
  // Production held four of them on 2026-08-25. The urgent one had been
  // accepted at roughly 118 hours of a customer waiting for a reply; it read
  // 142.3 hours a day later, still climbing, and could never come back.
  const { when } = guardOf("dismissed_at");
  assert.ok(
    when.includes("resolved_at is not null"),
    "an acceptance must still lapse when the finding resolves and returns"
  );
  assert.ok(
    when.includes("dismissed_until <= now()"),
    "an acceptance that outlives its horizon is a permanent mute -- the whole point of 065"
  );
});

test("forever is not on the menu", () => {
  // Every length offered has an end. The failure this closes was not somebody
  // choosing badly, it was there being no choice at all -- so the fix is not a
  // longer default, it is that no option silences anything permanently.
  assert.ok(HORIZONS.length >= 2, "a menu with one entry is not a choice");
  for (const h of HORIZONS) {
    assert.ok(
      Number.isFinite(h.hours) && h.hours > 0,
      `"${h.key}" does not describe a finite length of time`
    );
    assert.ok(h.label && h.describes, `"${h.key}" says nothing about what it means`);
  }
  const forever = HORIZONS.find((h) => /forever|never|permanent|always/i.test(h.key + h.label));
  assert.equal(forever, undefined, "a length that never ends is back on the menu");
});

test("a length the server does not know is refused, not defaulted", () => {
  // Quietly turning an unknown key into the default would silence a finding for
  // a length nobody chose, and would hide a browser and a server that disagree
  // about the menu.
  assert.ok("reason" in dismissalHorizon("fortnight"));
  assert.ok("reason" in dismissalHorizon(""));
  assert.ok("reason" in dismissalHorizon(undefined));
  assert.ok("reason" in dismissalHorizon(999));
  assert.ok(
    "horizon" in dismissalHorizon(DEFAULT_DISMISSAL_HORIZON),
    "the default is not itself on the menu"
  );
});

test("the writer builds its interval from a number, never from the request", () => {
  // make_interval(hours => $4::int), so the key never reaches SQL -- only the
  // hours the rules resolved it to.
  const at = DB.indexOf("export async function setFindingDismissal");
  assert.ok(at > -1, "the dismissal writer is gone");
  const fn = DB.slice(at, DB.indexOf("return (rowCount", at));
  assert.ok(fn.includes("make_interval(hours =>"), "the horizon is not applied by the writer");
  assert.ok(
    !fn.includes("interval '" + "\" +"),
    "an interval must not be assembled from a caller's string"
  );
});

test("the screen's fallback menu matches the server's", () => {
  // The page seeds its buttons so Accept works before the fetch returns. A
  // stale copy would offer a key the server refuses, which is an Accept button
  // that fails rather than one that is merely wrong.
  for (const h of HORIZONS) {
    assert.ok(PAGE.includes('key: "' + h.key + '"'), `the deck's fallback menu is missing "${h.key}"`);
  }
  const fallback = PAGE.slice(PAGE.indexOf("FALLBACK_HORIZONS"), PAGE.indexOf("const DEFAULT_HORIZON"));
  assert.ok(fallback.length > 100, "the deck's fallback menu could not be found to check");
  for (const part of fallback.split('key: "').slice(1)) {
    const key = part.slice(0, part.indexOf('"'));
    assert.ok(
      HORIZONS.some((h) => h.key === key),
      `the deck offers "${key}", which the server would refuse`
    );
  }
});

test("withdrawing an acceptance clears its end date too", () => {
  // Restore passes null everywhere. A row left with a dismissed_until and no
  // dismissed_at is one the sweep would try to lapse forever.
  assert.ok(
    ROUTE.includes("handleDismissal(c, null, null, null)"),
    "restore no longer clears the horizon"
  );
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
