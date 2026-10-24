// Every screen a staff member opens holds up (24 Oct 2026, walked through on
// screen signed in as a Zipicka sales executive).
//
// What was found, page by page:
//   - Home, "Your customers": noon, Shopify and Marketplace notices listed as
//     customers; every email chat offered a greyed-out "Message from my
//     WhatsApp" beside a red "Not reachable on WhatsApp"; a card with no name;
//     a hundred cards on the front page.
//   - Customers: a contact called "+null" (an email sender has no number).
//   - Tasks: a staff member of ONE business had to choose the business and
//     find themselves in the owner list before writing a follow-up.
//   - Workspace: "Every business" and "Add a rule" offered to staff, and a
//     "history could not be read" error — the runs are the owner's to see.
//   - Needs attention: "45 most serious of 50" counted colleagues' findings,
//     and the advice was the admin's ("check the worker and the webhook").
//   - My clients, My campaigns, Connections, Workspace: full-width pages with
//     small headings beside a product of centred calm pages; My settings
//     opened a tall empty gap in its right column.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

test("home: only real customers, named, each on its own channel", () => {
  const EMP = read("packages", "db", "src", "employees.ts");
  const q = EMP.slice(EMP.indexOf("export async function listConversationsForEmployee"));
  assert.match(q, /ct\.not_a_customer_at is null/);
  assert.match(q, /coalesce\(ct\.display_name, ct\.external_id\)/);
  assert.match(q, /coalesce\(c\.channel, 'whatsapp'\)\s+as channel/);
  const TW = read("apps", "web", "app", "deck", "team", "team-workspace.tsx");
  assert.match(TW, /href=\{`\/inbox\?conversation=\$\{conversation\.conversationId\}`\}/);
  assert.match(TW, /conversation\.channel === "whatsapp"/);
  assert.match(TW, /`Show all \$\{assigned\.length\}`/);
});

test("customers: an email sender is never '+null'", () => {
  const CT = read("packages", "db", "src", "contacts.ts");
  assert.ok((CT.match(/coalesce\(ct\.display_name, ct\.external_id\) as display_name/g) ?? []).length >= 2);
  const CU = read("apps", "web", "app", "deck", "customers", "page.tsx");
  assert.doesNotMatch(CU, /displayName \?\? `\+\$\{(contact|selected)\.waId\}`/);
});

test("tasks: a staff member's own business and own name come filled in", () => {
  const TK = read("apps", "web", "app", "deck", "tasks", "page.tsx");
  assert.match(TK, /visibleBusinesses\.length === 1/);
  assert.match(TK, /setDraftOwner\(myEmployeeId\)/);
});

test("workspace: staff get their board, not the owner's rules and switchers", () => {
  const BD = read("apps", "web", "app", "deck", "board", "page.tsx");
  assert.match(BD, /isOperator \? <Automations/);
  assert.match(BD, /isOperator \? \(\s*<div className="bd-view">/);
});

test("needs attention: a staff member's counts and advice are theirs", () => {
  const OP = read("apps", "api", "src", "routes", "operators.ts");
  assert.match(OP, /counts = countsOf\(kept\)/);
  assert.match(OP, /STAFF_ADVICE/);
});

test("every staff page sits in the same centred column", () => {
  const DECK = read("apps", "web", "app", "deck", "deck.css");
  assert.match(DECK, /\.deck-root:has\(> \.mc-head\)/);
  const BOARD = read("apps", "web", "app", "deck", "board", "board.css");
  assert.match(BOARD, /\.bd \{[^}]*max-width: 1120px/);
  const SET = read("apps", "web", "app", "deck", "my-settings", "my-settings.css");
  assert.match(SET, /grid-template-rows: auto 1fr/);
});
