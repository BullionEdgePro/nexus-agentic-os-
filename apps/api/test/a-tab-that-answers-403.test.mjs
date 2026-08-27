/**
 * Five tabs, four of which were forbidden to the person looking at them.
 *
 * ============================================================
 * WHAT WAS WRONG
 * ============================================================
 *
 * Thirteen deck screens each rendered their own copy of the same business
 * switcher, and every copy had the same two faults.
 *
 * They were labelled N-01 to N-05 — internal reference codes, on the control a
 * person uses to pick which of their own companies they are looking at.
 *
 * And they were all shown to everyone. An employee of one business saw five
 * tabs and could open one. The API was already right about this:
 * `requireTenantScope` refuses a slug outside the employee's own business and
 * its header explains why that is the half that matters, and `/api/operators`
 * narrows in the handler with a comment saying what happens if it forgets. So
 * nothing leaked. What the employee got instead was four buttons that look
 * enabled and answer 403 — a product that reads as broken.
 *
 * ============================================================
 * WHY A TEST AND NOT JUST A FIX
 * ============================================================
 *
 * Because the fault was thirteen copies of one thing, and the next screen
 * somebody adds will copy the nearest example. This fails on a new screen that
 * builds its own switcher out of the raw roster.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..", "web");
const deck = join(web, "app", "deck");

const screens = readdirSync(deck, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(deck, entry.name, "page.tsx")))
  .map((entry) => ({ name: entry.name, src: readFileSync(join(deck, entry.name, "page.tsx"), "utf8") }));

test("the deck has screens to check", () => {
  // A floor, so a rename cannot make every assertion below vacuous.
  assert.ok(screens.length >= 10, `only ${screens.length} deck screens found`);
});

test("no screen builds its own business switcher", () => {
  // The raw roster mapped into buttons is the shape that was wrong thirteen
  // times over. Using TENANTS for something else — a name lookup, a timezone —
  // is fine and common; rendering it as the switcher is not.
  const offenders = screens
    .filter((screen) => /TENANTS\.map\(/.test(screen.src))
    .map((screen) => screen.name);

  assert.deepEqual(
    offenders,
    [],
    `these build their own switcher instead of using BusinessTabs: ${offenders.join(", ")}.\n` +
      "A copy cannot be scoped to the viewer's business in one place, which is the whole point."
  );
});

test("no screen labels a business with its reference code", () => {
  // "N-05" is a thing to translate. "ABR Advocates" is a thing to read.
  const offenders = screens
    .filter((screen) => /\.ref\b(?!\s*=)/.test(screen.src.replace(/useRef|inputRef|\.current/g, "")))
    .map((screen) => screen.name);

  assert.deepEqual(offenders, [], `these still show a reference code: ${offenders.join(", ")}`);
});

test("the switcher waits rather than guessing who is asking", () => {
  const tabs = readFileSync(join(web, "lib", "business-tabs.tsx"), "utf8");

  // THE THIRD STATE. Assuming operator would flash five business names at an
  // employee on every page load — the one thing the scoping exists to prevent.
  // Assuming employee would flicker the owner's own tabs away and back.
  assert.match(tabs, /if \(!known\) return/, "it renders something before it knows the role");
  assert.match(tabs, /known: role !== null/, "there is no unknown state");
});

test("a role it could not read is treated as the narrow one", () => {
  const tabs = readFileSync(join(web, "lib", "business-tabs.tsx"), "utf8");
  const failure = tabs.slice(tabs.indexOf(".catch("), tabs.indexOf("return () =>"));
  assert.ok(
    failure.includes('setRole("employee")'),
    "a failed role read must not fall back to showing every business"
  );
});

test("an employee is still told which business they are looking at", () => {
  // Scoping is not the same as hiding. Five companies share one WhatsApp
  // number, so "whose customers are these" is worth answering even when the
  // answer cannot change.
  const tabs = readFileSync(join(web, "lib", "business-tabs.tsx"), "utf8");
  assert.match(tabs, /bt-only/);
  assert.match(tabs, /businesses\[0\]\?\.name/, "the single business must be named, not blank");
});
