/**
 * Staff-first compact Nexus, piece 2 (26 Nov 2026): on My queue a staff member
 * sees their chats first — the folder sidebar folds behind a "Filters" button
 * that says how many filters are on, the queue chips keep one phone row, and
 * their own rows leave out the line that names them. Admins: unchanged.
 * Spec: docs/superpowers/specs/2026-11-26-staff-first-my-queue-design.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as layout from "@/lib/inbox-layout";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---- Task 1: the rules ---------------------------------------------------------------------------

test("Filters start folded for staff, open for an admin; a stored choice wins", () => {
  const { filtersStartOpen } = layout;
  assert.equal(typeof filtersStartOpen, "function", "lib/inbox-layout exports no filtersStartOpen");
  assert.equal(filtersStartOpen(true, null), false);
  assert.equal(filtersStartOpen(false, null), true);
  assert.equal(filtersStartOpen(true, "open"), true);
  assert.equal(filtersStartOpen(false, "closed"), false);
  assert.equal(filtersStartOpen(true, "junk"), false);
});

test("the Filters count: anything on beyond the staff's own queue view", () => {
  const { activeFilterCount } = layout;
  assert.equal(typeof activeFilterCount, "function", "lib/inbox-layout exports no activeFilterCount");
  const Q = ["awaiting", "snoozed", "followup", "mine"];
  const base = { folder: "awaiting", tag: null, channel: null, dateRange: "any", stage: null, owner: "" };
  assert.equal(activeFilterCount(base, Q), 0);
  assert.equal(activeFilterCount({ ...base, folder: "late" }, Q), 1);
  assert.equal(activeFilterCount({ ...base, folder: "late", tag: "villa" }, Q), 2);
  assert.equal(activeFilterCount({ folder: "late", tag: "villa", channel: "email", dateRange: "7d", stage: "Viewing", owner: "e2" }, Q), 6);
  // An admin has no queue view: any folder is theirs to pick, only the View filters count.
  assert.equal(activeFilterCount({ ...base, folder: "late" }, null), 0);
  assert.equal(activeFilterCount({ ...base, folder: "late", tag: "villa" }, null), 1);
});

// ---- Task 2: the page and its styles ----------------------------------------------------------------

test("staff start with Filters folded; the button says how many are on", () => {
  const page = read("app/inbox/page.tsx");
  assert.match(page, /filtersStartOpen\(!!myEmployeeId, /);
  assert.match(page, /localStorage\.getItem\("nexus\.inbox\.filters"\)/);
  assert.match(page, /try \{\s*localStorage\.setItem\("nexus\.inbox\.filters"/);
  assert.match(page, /\$\{filtersOpen \? "" : " side-folded"\}/);
  assert.match(page, /className=\{`ibx-filters-btn\$\{filtersOpen \? " on" : ""\}`\}[\s\S]{0,200}aria-expanded=\{filtersOpen\}/);
  assert.match(page, /activeFilterCount\(\s*\{ folder, tag: tagFilter, channel: channelFilter, dateRange, stage: stageFilter, owner: ownerFilter \},\s*myEmployeeId \? QUEUE_KEYS : null\s*\)/);
  assert.match(page, /\{filterCount > 0 \? <span className="ibx-filters-n">\{filterCount\}<\/span> : null\}/);
  // Decided once the role is known — never on the first render, before it.
  assert.match(page, /if \(!known \|\| filtersDecided\.current\) return;/);
  // Folded until then (self-review, 26 Nov 2026): starting open made every staff visit
  // jump as the panel folded; before the role is known the panel holds nothing anyway.
  assert.match(page, /const \[filtersOpen, setFiltersOpen\] = useState\(false\);/);
});

test("a staff member's own row leaves out the line that names them, on the page", () => {
  const page = read("app/inbox/page.tsx");
  assert.match(page, /\{showsAssignee\(conversation, myEmployeeId\) \? \(\s*<span className="ibx-convo-sub">/);
});

test("folded is folded at every width, and the chips keep one row on a phone", () => {
  const css = read("app/inbox/inbox.css");
  assert.match(css, /\.ibx\.side-folded \.ibx-side \{ display: none; \}/);
  assert.match(css, /\.ibx\.side-folded \{ grid-template-columns: 0 /);
  assert.match(css, /\.ibx\.side-folded\.no-details \{ grid-template-columns: 0 /);
  const tablet = css.slice(css.indexOf("@media (max-width: 1100px)"));
  assert.match(tablet, /\.ibx\.side-folded \{[^}]*grid-template-areas:\s*"bar\s+bar"\s*"list\s+thread"\s*"list\s+thread"/);
  // Preview, 26 Nov 2026: the wide folded columns (.ibx.side-folded.no-details) outranked the
  // tablet and phone layouts and squeezed the list to a sliver. Each narrow layout sets its own.
  assert.match(tablet, /\.ibx\.side-folded,\s*\.ibx\.side-folded\.no-details \{ grid-template-columns: 300px minmax\(0, 1fr\); \}/);
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.ibx\.side-folded,\s*\.ibx\.side-folded\.no-details \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  // An open chat still takes the whole phone screen.
  assert.match(phone, /\.ibx\.side-folded:not\(\.has-thread\) \{[^}]*grid-template-areas: "bar" "list"/);
  assert.match(phone, /\.ibx-chips \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto/);
});

test("a staff member's own row leaves out the line that names them", () => {
  const { showsAssignee } = layout;
  assert.equal(typeof showsAssignee, "function", "lib/inbox-layout exports no showsAssignee");
  assert.equal(showsAssignee({ assignedEmployeeId: "e1" }, "e1"), false);
  assert.equal(showsAssignee({ assignedEmployeeId: "e2" }, "e1"), true);
  assert.equal(showsAssignee({ assignedEmployeeId: null }, "e1"), true);
  assert.equal(showsAssignee({ assignedEmployeeId: "e1" }, null), true);
});
