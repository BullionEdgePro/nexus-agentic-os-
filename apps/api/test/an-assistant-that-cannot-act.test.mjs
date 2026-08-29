/**
 * A help agent fails quietly, which is what makes it dangerous.
 *
 * ============================================================
 * THE WORST CASE IS NOT A WRONG ANSWER
 * ============================================================
 *
 * The customer agent's worst failure is telling somebody the wrong price — loud,
 * complained about, fixed. This one's worst failure is describing a screen that
 * does not exist. Nobody reports that. They look for it, fail to find it,
 * conclude the product is broken, and stop asking.
 *
 * So the grounding is explicit and the refusal instruction comes first, ahead of
 * tone, brevity and everything else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PLATFORM_FACTS,
  helpSystemPrompt,
  helpPrompt,
} from "../../../packages/agents/src/console-help.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const ROUTE = read("apps", "api", "src", "routes", "assistant.ts");
const PANEL = read("apps", "web", "app", "assistant.tsx");
const INDEX = read("apps", "api", "src", "index.ts");

// ============================================================
// It cannot act
// ============================================================

test("the assistant has no tools and changes nothing", () => {
  // An assistant that could enable a permission or send a campaign would be a
  // way to do those things without the confirmation screens they carry.
  assert.ok(!/tools:/.test(ROUTE), "the assistant has been given tools");
  assert.ok(
    !/updateBroadcastStatus|createBroadcast|claimClient|optOutOfReengagement|sendWhatsApp/.test(ROUTE),
    "the assistant route can now change something"
  );
});

test("it is told to say where, never that it has done it", () => {
  const prompt = helpSystemPrompt({ role: "employee", fullName: "Aqib", businessName: "Zipicka", facts: [] });
  assert.match(prompt, /You cannot DO anything/);
  assert.match(prompt, /never 'I have done that'/);
});

// ============================================================
// It is grounded, and told to refuse
// ============================================================

test("refusing to invent is the first rule, not the last", () => {
  // Order matters in an instruction list. Buried under tone and brevity, it is
  // the one the model trades away first.
  const prompt = helpSystemPrompt({ role: "employee", fullName: null, businessName: null, facts: [] });
  const refuse = prompt.indexOf("NEVER invent");
  const brevity = prompt.indexOf("Keep it short");
  assert.ok(refuse > -1 && brevity > refuse, "the instruction not to invent has slipped below tone");
});

test("the facts describe what does NOT exist, not only what does", () => {
  // A help agent asked "how do I connect my personal WhatsApp" invents a
  // settings page unless it has been told in words that there is not one.
  assert.match(PLATFORM_FACTS, /cannot read or send from the WhatsApp app on somebody's personal phone/i);
  assert.match(PLATFORM_FACTS, /cannot connect a personal Facebook profile/i);
  assert.match(PLATFORM_FACTS, /cannot read TikTok direct messages/i);
  assert.match(PLATFORM_FACTS, /There is NO account menu for staff/);
});

test("the facts match the platform as it actually is today", () => {
  // Whitespace collapsed first. The facts are wrapped prose, so a phrase that
  // reads as one sentence spans a line break in the source — matching the raw
  // text fails on where the wrapping happened rather than on what it says.
  const facts = PLATFORM_FACTS.replace(/\s+/g, " ");
  // Each of these was true when written and each has been wrong at some point
  // during this build, which is why they are pinned rather than trusted.
  assert.match(facts, /Campaigns are switched ON for every staff member by default/);
  assert.match(facts, /no monthly limit set by this platform/);
  assert.match(facts, /250 new conversations per rolling 24/);
  assert.match(facts, /My clients → Your link/);
  assert.match(facts, /access code/);
});

// ============================================================
// Scope
// ============================================================

test("a staff member is told they are staff", () => {
  // Otherwise it cheerfully explains owner-only screens as things they can open,
  // which is the same defect as a menu of closed doors, arriving by voice.
  const staff = helpSystemPrompt({ role: "employee", fullName: "Aqib", businessName: "Zipicka", facts: [] });
  assert.match(staff, /STAFF MEMBER at Zipicka/);
  assert.match(staff, /Do not describe owner-only screens as things they can open/);

  const owner = helpSystemPrompt({ role: "operator", fullName: "Ralph", businessName: null, facts: [] });
  assert.match(owner, /OWNER of this platform/);
});

test("live facts are read with the caller's own scope", () => {
  // There is no path here that widens a tenant. The assistant can say how many
  // clients THIS person has; it is never handed another business's anything.
  assert.match(ROUTE, /withTenant\(scope\.organizationId/);
  assert.ok(!/withAllTenants/.test(ROUTE), "the assistant reads across tenants");
});

test("the history the caller sends is never trusted for access", () => {
  // A history the caller supplies is a history the caller can forge. It is used
  // for continuity of wording and nothing else.
  assert.match(ROUTE, /never trusted|never grants access|can forge/);
  assert.match(ROUTE, /slice\(-6\)/);
});

// ============================================================
// Cost and failure
// ============================================================

test("there is a ceiling on questions per person", () => {
  // This costs money per question and a chat box is the one control a person
  // can hold down.
  assert.match(ROUTE, /HOURLY_LIMIT/);
  assert.match(ROUTE, /429/);
});

test("an unreachable model says so instead of inventing a fallback", () => {
  // completeText returns null on failure. A cheerful canned reply would look
  // exactly like an answer.
  assert.match(ROUTE, /if \(!answer\)/);
  assert.match(ROUTE, /could not reach the assistant/);
  assert.match(ROUTE, /502/);
});

test("the panel keeps the question on screen when an answer fails", () => {
  // Removing it makes somebody retype what they just wrote.
  assert.match(PANEL, /The question stays on screen/);
});

// ============================================================
// Where it lives
// ============================================================

test("both roles get it", () => {
  assert.match(INDEX, /app\.route\("\/api\/assistant", assistantRoute\)/);
  assert.ok(
    !/app\.use\("\/api\/assistant", operatorOnly\)/.test(INDEX),
    "the assistant has become operator-only"
  );
  const SHELL = read("apps", "web", "app", "console-shell.tsx");
  const DECK = read("apps", "web", "app", "deck-console.tsx");
  assert.match(SHELL, /<Assistant \/>/);
  assert.match(DECK, /<Assistant \/>/, "the owner is the one person without help");
});

test("the disclaimer survives a long conversation", () => {
  // In the header rather than as a first message, so it is still visible after
  // twenty turns.
  assert.match(PANEL, /It cannot change anything/);
  const head = PANEL.slice(PANEL.indexOf("as-head"), PANEL.indexOf("as-body"));
  assert.match(head, /cannot change anything/);
});

test("the openers are questions, not commands", () => {
  // "Add a client for me" invites the answer it cannot give.
  // Anchored on the ARRAY, not on the first occurrence of the phrase. That
  // phrase appears first in this component's own doc comment, which quotes
  // "Add a client for me" as the counter-example — so the slice began in prose
  // arguing for the rule and failed on the thing it was arguing against. Third
  // time a doc comment has caught one of these; anchor on markup.
  const openers = PANEL.slice(PANEL.indexOf("{["), PANEL.indexOf("].map"));
  for (const line of openers.split("\n").filter((l) => l.includes('"'))) {
    assert.ok(/\?"/.test(line), `opener is not a question: ${line.trim()}`);
  }
});

// ============================================================
// The prompt itself
// ============================================================

test("history is bounded so a long chat does not grow without limit", () => {
  const long = Array.from({ length: 40 }, (_, i) => ({ role: "user", text: `q${i}` }));
  const prompt = helpPrompt(long, "the newest question");
  assert.ok(!prompt.includes("q0"), "the whole history is being sent");
  assert.match(prompt, /the newest question/);
});
