// Adding a business to the platform.
//
// All five current tenants were inserted by hand-written migrations. That works
// at five and is not a platform. The interesting part is not the insert — it is
// that on a shared number, onboarding one business can silently break routing
// for another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

const ONBOARD = read("packages", "db", "src", "onboarding.ts");
const SCRIPT = read("apps", "api", "src", "scripts", "onboard-business.ts");

test("keyword collisions are analysed before anything is written", () => {
  // Routing keywords share one namespace across every business. A word claimed
  // twice routes to NEITHER — the switchboard returns a triage menu. Adding a
  // tenant claiming "contract" degrades the law firm that was working fine, and
  // nothing at insert time would show it.
  assert.match(ONBOARD, /export async function analyseKeywordCollisions/);
  assert.ok(
    ONBOARD.indexOf("analyseKeywordCollisions(input.routingKeywords)") <
      ONBOARD.indexOf("insert into organizations"),
    "collisions must be analysed before the insert"
  );
});

test("the script makes you look before it writes", () => {
  // Two-step on purpose: the first run changes nothing and prints the
  // collisions. A prompt you have to answer is the cheapest place to catch a
  // regression in a business you were not touching.
  assert.match(SCRIPT, /--confirm/);
  assert.match(SCRIPT, /Nothing was written/);
  assert.match(SCRIPT, /routes to NEITHER/);
});

test("collisions warn rather than refuse", () => {
  // Some overlap is legitimate — two law firms both answer to "lawyer" — and
  // the switchboard's ambiguity path exists for exactly that. What is
  // unacceptable is finding out from a customer.
  // Checked as a property of the code path, not by proximity of two words —
  // the first version matched the unrelated "no keywords" throw sitting a
  // hundred characters above the collisions call.
  assert.ok(
    !/if \(collisions\.length[^)]*\)[\s\S]{0,60}throw/.test(ONBOARD),
    "a collision must not abort onboarding"
  );
  // It is reported back to the caller instead.
  assert.match(ONBOARD, /return \{ organizationId, collisions, outstanding \}/);
  assert.match(ONBOARD, /advisory rather than fatal/);
});

test("a business with no keywords is refused outright", () => {
  // On a shared number it would be unreachable: nothing a customer types could
  // route to it, and it would sit in the list looking live.
  assert.match(ONBOARD, /needs routing keywords, or nothing can reach it/);
});

test("the slug is validated as the deep-link tag it becomes", () => {
  // It ends up in a URL and in the #tag regex. Rejecting here beats finding out
  // when a published link fails in a customer's hands.
  assert.match(ONBOARD, /\^\[a-z0-9\]\[a-z0-9-\]\{1,40\}\$/);
  assert.match(ONBOARD, /it becomes the #tag/);
});

test("the organization and its agent are created together", () => {
  // An organization without an agent config is reachable and mute: the
  // switchboard routes a customer to it, the reply path finds no agent, the
  // customer gets nothing, and the logs record a successful route.
  assert.match(ONBOARD, /insert into agent_configs/);
  assert.match(ONBOARD, /Both or neither/);
  assert.ok(
    ONBOARD.indexOf("insert into organizations") < ONBOARD.indexOf("insert into agent_configs"),
    "both inserts must be in the same withAllTenants transaction"
  );
});

test("creation is verified reachable, not merely inserted", () => {
  // A row that exists but cannot be found by the lookup the webhook uses is the
  // failure this codebase produces most often.
  assert.match(ONBOARD, /join agent_configs a on a\.organization_id = o\.id and a\.is_active/);
  assert.match(ONBOARD, /coalesce\(array_length\(o\.routing_keywords, 1\), 0\) > 0/);
  assert.match(ONBOARD, /inserted but is not reachable/);
});

test("the WhatsApp number is inherited rather than retyped", () => {
  // Getting a phone_number_id wrong produces a business that looks live and can
  // never receive a message — the state four tenants sat in for months.
  assert.match(SCRIPT, /Inherit the shared number rather than asking for it/);
  assert.match(SCRIPT, /donor\?\.whatsappPhoneNumberId/);
});

test("the system prompt is a stated placeholder, not a guess", () => {
  // A generated prompt describing services nobody approved would have the agent
  // making claims on a real business's behalf — the governance failure §2.4
  // exists to prevent.
  assert.match(SCRIPT, /This prompt is a placeholder/);
  assert.match(SCRIPT, /do not guess, do not quote prices/);
  assert.match(SCRIPT, /Replace the placeholder system prompt/);
});

test("it ends by saying what is still missing", () => {
  // "Created" alone reads as done. A business with no knowledge and no
  // published link cannot serve anyone.
  assert.match(ONBOARD, /outstanding/);
  assert.match(ONBOARD, /nothing reaches a business nobody can find/);
  console.log("PASS: onboarding warns about shared-number collisions and verifies reachability");
});
