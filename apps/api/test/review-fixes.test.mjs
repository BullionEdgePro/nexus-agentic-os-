// Four defects found by reviewing the day's own diff, after eight others had
// been found by running the system. These are the ones inspection caught that
// execution had not — which is the argument for doing both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { normalizeForMatch } from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const ONBOARDING = read("packages", "db", "src", "onboarding.ts");
const LINKS_PAGE = read("apps", "web", "app", "deck", "links", "page.tsx");

// ============================================================
// 1. A floating promise must not outlive its transaction
// ============================================================

test("the contact memory is written after the tenant transaction closes", () => {
  // The serious one. Fired with `void` INSIDE withTenant, the summariser's
  // Gemini call resolves seconds later — after the transaction has committed
  // and the pooled client has been released. AsyncLocalStorage propagates the
  // context into that continuation, so the write routes to a released client.
  // If the pool has already reassigned it, the write lands in ANOTHER
  // business's transaction under ITS app.current_org: one company's customer
  // memory stored against another's, the exact cross-tenant write RLS exists
  // to prevent.
  const closeIndex = PROCESSOR.indexOf("\n  });\n");
  const rememberIndex = PROCESSOR.indexOf("rememberContact(pending)");
  assert.ok(rememberIndex > closeIndex, "rememberContact must run after the tenant block closes");
  assert.match(PROCESSOR, /void withTenant\(pending\.organizationId, \(\) => rememberContact\(pending\)\)/);
});

test("nothing else is fired without await inside a tenant block", () => {
  // Anchored on unambiguous markers. Looking for the first "  });" in the file
  // finds a nested callback hundreds of lines earlier, so the slice covered the
  // wrong region and the check proved nothing.
  const block = PROCESSOR.slice(
    PROCESSOR.indexOf("await withTenant(organization.id, async () => {"),
    PROCESSOR.indexOf("const pending = deferred.memory;")
  );
  assert.ok(block.length > 500, "the tenant block slice must not be empty");
  assert.ok(!/\bvoid [a-zA-Z]+\(/.test(block), "no un-awaited call may run inside the transaction");
});

test("the deferred value survives TypeScript's narrowing", () => {
  // A bare `let` initialised to null is narrowed to `null`, because control-flow
  // analysis assumes the callback may never run — the check afterwards then
  // becomes unreachable and the memory is silently never written.
  assert.match(PROCESSOR, /const deferred: \{/);
  assert.match(PROCESSOR, /deferred\.memory = \{ organizationId: serving\.id/);
});

// ============================================================
// 2. One normaliser, shared by everything that compares text
// ============================================================

test("the collision audit folds text exactly as the matcher does", () => {
  // The audit used trim().toLowerCase(); the switchboard uses normalizeForMatch,
  // which also folds Arabic orthography. Two keywords differing only by hamza
  // compared as different, so no collision was reported — while the matcher saw
  // one and routed the word to neither business. A clean report gets acted on,
  // which makes a weak audit worse than no audit.
  assert.match(ONBOARDING, /import \{ normalizeForMatch \} from "@nexus\/shared"/);
  assert.match(ONBOARDING, /const normalise = \(word: string\) => normalizeForMatch\(word\)/);
  // Checked against code, not the file — the comment above the fix names the old
  // approach on purpose, and a file-wide scan would flag the explanation.
  const code = ONBOARDING.split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.ok(!/trim\(\)\.toLowerCase\(\)/.test(code), "the weak normaliser must be gone");
});

test("the shared normaliser really folds the forms that caused this", () => {
  // Behavioural, not textual — the whole point is that the two layers agree.
  assert.equal(normalizeForMatch("إيجار"), normalizeForMatch("ايجار"), "hamza must fold");
  assert.equal(normalizeForMatch("قضية"), normalizeForMatch("قضيه"), "taa marbuta must fold");
  assert.equal(normalizeForMatch("  Lawyer  "), "lawyer");
});

test("there is exactly one implementation of it", () => {
  // It lives in shared because leads depends on db, so db could not import it —
  // which is precisely how the duplicate arose.
  const LEADS = read("packages", "leads", "src", "score.ts");
  assert.match(LEADS, /import \{ normalizeForMatch \} from "@nexus\/shared"/);
  assert.ok(!/export function normalizeForMatch/.test(LEADS), "no second copy");
});

// ============================================================
// 3. Recalled memory is not presented as the agent's own words
// ============================================================

test("recalled memory is fenced as an internal note", () => {
  // A turn can only be "user" or "assistant". Injected as "assistant" it tells
  // the model it said this to the customer, and the predictable result is "as I
  // mentioned…" about a conversation that never happened. Role outweighs any
  // instruction buried in the text, so the text now declares itself first.
  assert.match(PROCESSOR, /\[INTERNAL NOTE — staff context only/);
  assert.match(PROCESSOR, /This was NOT said to the customer/);
  assert.match(PROCESSOR, /Do not quote it, refer to it, or imply you have spoken before/);
});

// ============================================================
// 4. The download must outlive its object URL
// ============================================================

test("the object URL is revoked after the download can start", () => {
  // click() only queues the download. Revoking on the next line can invalidate
  // the blob first, and in Firefox and Safari the download fails silently — no
  // error, no file, and an operator who concludes the QR feature is broken.
  assert.match(LINKS_PAGE, /setTimeout\(\(\) => URL\.revokeObjectURL\(href\), 0\)/);
  assert.ok(
    !/anchor\.click\(\);\s*\n\s*URL\.revokeObjectURL/.test(LINKS_PAGE),
    "must not revoke synchronously after click"
  );
  console.log("PASS: review findings fixed — no write escapes its transaction, one normaliser, memory fenced");
});
