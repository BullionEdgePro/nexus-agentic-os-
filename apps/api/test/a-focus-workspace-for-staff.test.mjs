// The Focus workspace for staff (24 Oct 2026). Owner: "make the best ui/ux
// design of this platform ... better than our competitors ... reliable, smart
// and creative". Mockups approved; spec:
// docs/superpowers/specs/2026-10-24-focus-workspace-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const INBOX = () => read("apps", "web", "app", "inbox", "page.tsx");

// ---- §1 My queue -------------------------------------------------------------

test("staff land on their queue: waiting, longest waiting first", () => {
  const src = INBOX();
  const landing = src.slice(src.indexOf("if (myEmployeeId) {"), src.indexOf("if (myEmployeeId) {") + 400);
  assert.match(landing, /setFolder\("awaiting"\)/);
  assert.match(landing, /setOldestFirst\(true\)/);
  assert.match(src, /\["awaiting", "Waiting"\]/);
  assert.match(src, /\["snoozed", "Snoozed"\]/);
  assert.match(read("apps", "web", "lib", "nav.tsx"), /staffLabel: "My queue"/);
});

test("each chat says why it matters", () => {
  const src = INBOX();
  for (const label of ["Wants to buy", "High value", "Complaint", "Sales pitch"]) assert.match(src, new RegExp(label));
});

// ---- §3 Shortcuts and the command bar ---------------------------------------

test("a shortcut never fires while somebody is typing", () => {
  const KEYS = read("apps", "web", "app", "inbox", "shortcuts.tsx");
  assert.match(KEYS, /tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT"/);
  assert.match(KEYS, /isContentEditable/);
  assert.match(KEYS, /if \(isTypingTarget\(event\.target\)\) return;/);
  assert.match(KEYS, /event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey/);
});

test("every shortcut is wired, and listed on the sheet", () => {
  const src = INBOX();
  for (const key of ["j:", "k:", "r:", "e:", "s:", "a:", "x:", '"?":']) assert.ok(src.includes(`    ${key}`), key);
  const KEYS = read("apps", "web", "app", "inbox", "shortcuts.tsx");
  for (const row of ["Resolve", "Snooze", "Ask a colleague", "Not a customer", "Team chat"]) assert.match(KEYS, new RegExp(row));
});

test("the command bar offers the open chat's actions first, and clears them when it closes", () => {
  const PALETTE = read("apps", "web", "app", "command-palette.tsx");
  assert.match(PALETTE, /\[\.\.\.actionHits, \.\.\.screenHits, \.\.\.clientHits\]/);
  const src = INBOX();
  assert.match(src, /setCommandActions\(`For this chat · \$\{name\}`/);
  assert.match(src, /useEffect\(\(\) => \(\) => clearCommandActions\(\), \[\]\)/);
});
