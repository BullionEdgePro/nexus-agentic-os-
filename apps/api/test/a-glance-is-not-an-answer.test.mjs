/**
 * Opening the activity panel must not silence an urgent finding.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * The notifications bell showed a dot when `fresh.length > 0`, where `fresh` is
 * findings first seen since `seenAt` — and `seenAt` is written to localStorage
 * when the panel is OPENED. One glance therefore marked everything currently
 * listed as seen, permanently, on that machine.
 *
 * So an urgent finding stopped being mentioned while remaining completely
 * unactioned. Not hypothetically: on 2026-08-24 one urgent finding had been open
 * since the 19th — a customer waiting 116 hours for a person to answer them —
 * and the bell was dark, because somebody had opened the panel at some point in
 * between.
 *
 * This is the same sentence as the webhook replay two commits earlier, in a
 * different place: SEEN IS NOT THE SAME AS ANSWERED. There the platform confused
 * "this message was stored" with "this message was replied to". Here it confused
 * "you looked at the list" with "you dealt with the list".
 *
 * The platform already has the honest signal, and it was built for exactly this
 * reason: the DISMISSAL. It is explicit, it carries a reason, it records who,
 * and it LAPSES the moment the finding lapses — see
 * `a-dismissal-lapses-when-the-finding-does`. A localStorage timestamp from one
 * glance is not that, and must not be read as if it were.
 *
 * ============================================================
 * WHAT IT PINS
 * ============================================================
 *
 * That the badge is driven by unaccepted urgency as well as by novelty, that
 * the two are not the same colour, and that `seenAt` cannot clear the urgent
 * one. Source-level, because the alternative is a browser and a clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..", "web");
const MENUS = readFileSync(join(web, "app", "header-menus.tsx"), "utf8");
const CSS = readFileSync(join(web, "app", "header-menus.css"), "utf8");

/** The component's code, with prose removed so a comment cannot satisfy a claim. */
const code = withoutComments(MENUS);

test("urgency is judged by the dismissal, not by when you last looked", () => {
  const at = code.indexOf("const nagging");
  assert.notEqual(at, -1, "there is no separate signal for unaccepted urgency");

  const decl = code.slice(at, at + 320);
  assert.ok(decl.includes('severity === "urgent"'), "the nagging signal must be about urgency");
  assert.ok(decl.includes("!f.dismissedAt"), "an accepted finding must stop nagging");
  assert.ok(
    !decl.includes("seenAt"),
    "seenAt must not enter this: a glance is not an acceptance, which is the whole defect"
  );
});

test("the dot appears for an unaccepted urgent finding even with nothing new", () => {
  // THE GATING CONDITION, not something near the badge.
  //
  // The first version of this looked for `nagging.length` within 260
  // characters of the string "badge dot-only" and passed when the condition
  // was reverted to novelty-only -- because `nagging.length` still appeared
  // right there, in the className ternary choosing the dot's colour. It
  // checked proximity and called it a property. A sibling test in
  // activity-broadcasts caught the revert; this one did not, which is the only
  // reason the weakness was visible at all.
  const flat = code.replace(/\s+/g, " ");
  assert.ok(
    flat.includes("nagging.length || fresh.length || mine.length ? ("),
    "the dot must be gated on unaccepted urgency OR novelty OR work assigned to the reader — " +
      "gated on novelty alone, a five-day-old urgent finding shows nothing once somebody has " +
      "glanced at the panel"
  );
  // The opening brace moved when the unreachable state was put in front of this
  // condition, which is the THIRD time this assertion has gone red on the
  // condition growing. Each time the growth was the point, so it now matches
  // the condition rather than the punctuation around it.
  assert.ok(
    flat.includes("reachable === false ? ("),
    "an unreachable check must be distinguishable from a quiet one"
  );
});

test("work assigned to you does not clear when you glance at it", () => {
  // THE SAME DEFECT, IN THE SECTION ADDED NEXT TO IT. `fresh` is a
  // "since you last opened this panel" marker and is honest about being one.
  // A person's own outstanding work is not that: it stops mattering when the
  // work is done, and at no other moment.
  const at = code.indexOf("const mine, setMine");
  const decl = code.slice(code.indexOf("const [mine, setMine]"), code.indexOf("const [seenAt"));
  assert.ok(decl.length > 20, "the yours list is gone");
  assert.ok(
    !decl.includes("seenAt"),
    "seenAt must not enter this: glancing at a list is not doing the work on it"
  );
  assert.equal(at, -1, "unexpected declaration shape -- re-read this test");

  // And the list itself is filtered on status, not on having been seen.
  assert.ok(
    code.includes('getTasks({ mine: true, status: "open" })'),
    "the yours list must be the open work assigned to the caller"
  );
});

test("late work of your own turns the dot red", () => {
  // A dot that means "you have things" and a dot that means "you have things
  // that are already late" should not be the same dot, for the same reason the
  // two findings dots were separated.
  const flat = code.replace(/\s+/g, " ");
  assert.ok(
    flat.includes('nagging.length || mineOverdue.length ? "badge dot-only urgent"'),
    "your own overdue work must reach the urgent colour"
  );
  // The server's verdict, never the browser's clock.
  assert.ok(
    code.includes("mine.filter((t) => t.isOverdue)"),
    "overdue must come from the server -- a slow browser clock would call late work fine"
  );
});

test("the two dots are not the same colour", () => {
  // "Three info findings arrived" and "somebody has been waiting five days"
  // were both a red dot, which makes the red one worthless.
  assert.match(CSS, /\.badge\.dot-only\s*\{[^}]*background:\s*var\(--warn\)/s);
  assert.match(CSS, /\.badge\.dot-only\.urgent\s*\{[^}]*background:\s*var\(--crit\)/s);
});

test("the panel's own summary leads with urgency", () => {
  // Somebody who opens the panel because of a red dot must be told which of the
  // eight rows is the reason, not just that something is new.
  assert.ok(
    code.includes("`${nagging.length} urgent`"),
    "the panel header should say how many are urgent when any are"
  );
});

test("a dark bell does not mean all clear when nothing could be asked", () => {
  // THE SAME DEFECT AS THE ONE ABOVE, THROUGH THE DOOR NOBODY WATCHED.
  //
  // getFindings().catch(() => undefined) left `findings` empty, so a failed
  // fetch produced no dot — and no dot is how this control says "nothing needs
  // attention". An outage, an expired session or a 500 rendered as all clear,
  // on the one control whose entire job is to nag about a customer who has
  // been waiting five days.
  //
  // Three states, not two: the same shape /deck/operators already uses for its
  // alert destination, and for the same reason.
  assert.ok(
    code.includes("const [reachable, setReachable] = useState<boolean | null>(null)"),
    "the bell cannot tell 'nothing to report' from 'could not ask'"
  );
  assert.ok(
    code.includes("catch(() => setReachable(false))"),
    "a failed findings fetch is still swallowed"
  );
  // Plain fragments. Written first as a flattened-whitespace comparison whose
  // escapes were eaten on the way in — the thirteenth instance of that today,
  // and the argument for not reaching for a pattern when a string will do.
  assert.ok(code.includes("reachable === false ? ("), "the unreachable state is not rendered");
  assert.ok(
    code.includes('className="badge dot-only unknown"'),
    "an unreachable check does not show its own state"
  );
});

test("uncertainty is not coloured like an alarm", () => {
  // Nothing is KNOWN to be wrong. Painting that red would teach somebody to
  // discount red, which costs more than the case it was meant to cover.
  const at = CSS.indexOf(".badge.dot-only.unknown");
  assert.ok(at > -1, "the unreachable dot has no style of its own");
  const rule = CSS.slice(at, CSS.indexOf("}", at));
  assert.ok(rule.includes("var(--mist)"), "uncertainty is not muted");
  assert.ok(!rule.includes("var(--crit)"), "uncertainty is coloured as an alarm");
});
