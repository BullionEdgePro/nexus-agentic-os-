/**
 * Meta approved it. That says what it may send, not who it is for.
 *
 * ============================================================
 * WHAT WAS MEASURED
 * ============================================================
 *
 * Asked on 2026-08-26 to check the template situation again, because the owner
 * believed Facebook had already approved them. They had, and I had been saying
 * otherwise: 35 rows on production, every one APPROVED, synced that day.
 *
 * The 35 is the defect. There are 7 real templates on the WhatsApp Business
 * Account and five businesses share that account, so each business's sync pulls
 * back all 7 and writes them under its own `organization_id`. ABR holds an
 * APPROVED copy of `zipicka_order_update`. So does the other law firm.
 *
 * Two ways that reached a customer's phone, and neither was hypothetical:
 *
 *   1. `getBroadcastTemplate(body.templateId)` was fetched by id and NOTHING
 *      compared it to the organization the broadcast was for. The send route
 *      one function below already carried a test for exactly this shape, about
 *      the organization slug, with a comment explaining that a request pairing
 *      broadcast A with organization B would message the wrong company's
 *      customers. The create route had the same hole for the template.
 *
 *   2. Even with that closed, ABR's OWN row for `zipicka_order_update` is
 *      approved and real. A law firm's clients would receive "There is an
 *      update on your order with us."
 *
 * Attribution cannot come from Meta, which knows one account and not five
 * tenants. It comes from `@nexus/shared`, and these tests are what stop that
 * list drifting from the script that creates the templates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PROVISIONED_TEMPLATE_BY_SLUG,
  templateOwnerSlug,
  attributeTemplate,
  describeWrongTemplate,
} from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const ROUTE = read("apps", "api", "src", "routes", "broadcasts.ts");
const PROVISION = read("apps", "api", "src", "scripts", "provision-templates.ts");
const PAGE = read("apps", "web", "app", "deck", "broadcasts", "page.tsx");

// ============================================================
// Who a template speaks for
// ============================================================

test("a business may send its own template", () => {
  assert.equal(attributeTemplate("abr_matter_update", "abr"), "own");
  assert.equal(attributeTemplate("zipicka_order_update", "zipicka"), "own");
});

test("a business may not send another's, however approved it is", () => {
  // The whole finding, in one assertion. Both of these rows exist on
  // production, both are APPROVED, and both were offerable before this.
  assert.equal(attributeTemplate("zipicka_order_update", "abr"), "other-business");
  assert.equal(attributeTemplate("abr_matter_update", "juris-prime-legal"), "other-business");
  assert.equal(
    attributeTemplate("juris_prime_legal_update", "juris-prime"),
    "other-business",
    "the two Juris Prime businesses are separate tenants and the names are one word apart"
  );
});

test("a template nobody here made is not refused", () => {
  // `klaviyo_default_helpdesk_template` and `klaviyo_double_optin` sit on the
  // account from another integration. Refusing everything unrecognised would
  // also refuse a template created by hand in Meta's console, and somebody
  // would reasonably read that as the sync being broken.
  //
  // Three answers, not two: unknown is not "unsafe", it is "this platform does
  // not know", which the caller decides about.
  assert.equal(attributeTemplate("klaviyo_double_optin", "abr"), "unattributed");
  assert.equal(templateOwnerSlug("something_made_by_hand"), null);
});

test("the refusal names both businesses", () => {
  // "That template is not yours" sends somebody to compare seven near-identical
  // names. Saying which company it speaks for ends the question.
  const message = describeWrongTemplate("zipicka_order_update", "abr");
  assert.match(message, /zipicka/);
  assert.match(message, /abr/);
  assert.match(message, /Meta approving it says nothing about who it is for/);
});

// ============================================================
// The list and the script cannot drift
// ============================================================

test("every provisioned template is attributed to the business that provisions it", () => {
  // TWO COPIES OF ONE FACT IS HOW THIS CODEBASE HAS BEEN BITTEN BEFORE -- the
  // nav rail and the operator-only list drifted precisely because nothing
  // connected them. The script creates the templates; the shared map decides
  // who may send them. If they disagree, a business is silently refused its own
  // template, or offered somebody else's.
  for (const [slug, name] of Object.entries(PROVISIONED_TEMPLATE_BY_SLUG)) {
    assert.ok(
      PROVISION.includes(`slug: "${slug}"`),
      `${slug} is attributed a template but the provisioning script does not create one for it`
    );
    assert.ok(
      PROVISION.includes(`name: "${name}"`),
      `${slug} is attributed "${name}", which the provisioning script never creates`
    );
  }
});

test("the provisioning script creates nothing the map has not heard of", () => {
  // The other direction. A template added to the script and not to the map
  // would be "unattributed" -- sendable by every business, which is the
  // permissive half of the very thing this is for.
  const created = [...PROVISION.matchAll(/name: "([a-z0-9_]+)"/g)].map((m) => m[1]);
  assert.ok(created.length >= 5, `only found ${created.length} template names in the script`);
  for (const name of created) {
    assert.notEqual(
      templateOwnerSlug(name),
      null,
      `the script creates "${name}" and no business claims it`
    );
  }
});

// ============================================================
// Where it is enforced
// ============================================================

test("the create route checks the row belongs to the business", () => {
  // Defect 1. The row was fetched by id and never compared.
  assert.ok(
    ROUTE.includes("template.organizationId !== organization.id"),
    "a broadcast can still be paired with another business's template row"
  );
});

test("the create route checks the name does not speak for somebody else", () => {
  // Defect 2, which survives defect 1 being fixed.
  const at = ROUTE.indexOf('broadcastsRoute.post("/"');
  const body = ROUTE.slice(at, ROUTE.indexOf('broadcastsRoute.post("/:id/send"'));
  assert.ok(body.includes("attributeTemplate("), "the create route does not attribute the template");
  assert.ok(body.includes('=== "other-business"') || body.includes('attribution === "other-business"'));
});

test("the send route checks both again, and for a different reason", () => {
  // Approval is re-checked at send because Meta can withdraw it. Ownership
  // cannot change -- but a broadcast DRAFTED before these checks shipped can
  // still be sitting in the table with another business's template chosen, and
  // this route is the last thing between that row and a customer's phone.
  const at = ROUTE.indexOf('broadcastsRoute.post("/:id/send"');
  const body = ROUTE.slice(at);
  assert.ok(body.includes("template.organizationId !== organization.id"));
  assert.ok(body.includes('attributeTemplate(template.metaTemplateName, organization.slug) === "other-business"'));
});

test("the template getter reads the column the check needs", () => {
  // It selected four fields and not organization_id, so the create route could
  // not have made this comparison even if it had tried to.
  const DB = read("packages", "db", "src", "broadcasts.ts");
  const at = DB.indexOf("export async function getBroadcastTemplate(");
  const body = DB.slice(at, at + 900);
  assert.ok(body.includes("select organization_id,"), "organization_id is not selected");
  assert.ok(body.includes("organizationId: row.organization_id"), "it is selected and then dropped");
});

// ============================================================
// What the screen offers
// ============================================================

test("the picker does not offer what the server will refuse", () => {
  // Being refused at 422 after choosing is a worse experience than not being
  // offered, and on this screen the choice is followed by a bulk send.
  assert.ok(
    PAGE.includes('t.isApproved && t.attribution !== "other-business"'),
    "the sendable list is still 'anything approved'"
  );
});

test("nothing is pre-selected that belongs to somebody else", () => {
  // The default was the first approved row, which for four of the five
  // businesses was another company's template, already chosen when the page
  // finished loading.
  const at = PAGE.indexOf("setTemplateId(");
  const body = PAGE.slice(at, at + 240);
  assert.ok(
    body.includes('attribution !== "other-business"'),
    "the default selection is not filtered"
  );
});

test("the screen says a send is possible only when one actually is", () => {
  // `canSend` was `some(isApproved)`, which was true for every business the
  // moment any template anywhere on the shared account was approved.
  assert.ok(
    ROUTE.includes('template.isApproved && template.attribution !== "other-business"'),
    "canSend still counts other businesses' templates"
  );
});

test("hidden rows are explained rather than silently dropped", () => {
  // A picker shorter than the table above it invites the reader to think the
  // list is broken.
  assert.ok(PAGE.includes("belong to other businesses on the shared"), "the omission is unexplained");
});
