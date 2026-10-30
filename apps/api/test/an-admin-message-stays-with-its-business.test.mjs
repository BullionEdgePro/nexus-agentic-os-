/**
 * Admins write new approved messages from Bulk messaging (30 Oct 2026).
 *
 * The template sync copies every template on a WhatsApp account into every
 * business that shares it, so the only owner a template can carry is its name.
 * A plain new name would be "unattributed" — offered to all five businesses —
 * so an admin's message is named `bulk_<business code>_<label>`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  attributeTemplate,
  bulkTemplateLabel,
  bulkTemplateName,
  isBulkTemplate,
  templateOwnerSlug,
} from "@nexus/shared";
import { explainRejection, pendingFrom } from "../src/lib/pending-templates.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

test("an admin message is named for its business", () => {
  assert.equal(bulkTemplateName("sfs-international", "Weekend viewings!"), "bulk_sfs_weekend_viewings");
  assert.equal(bulkTemplateName("juris-prime-legal", "x".repeat(80)).length <= "bulk_jpl_".length + 48, true);
  assert.equal(bulkTemplateName("review-demo", "Hi"), null);
});

test("it is offered to its own business and to nobody else", () => {
  assert.equal(attributeTemplate("bulk_sfs_weekend_viewings", "sfs-international"), "own");
  assert.equal(attributeTemplate("bulk_sfs_weekend_viewings", "zipicka"), "other-business");
  assert.equal(attributeTemplate("bulk_zz_anything", "zipicka"), "other-business");
  assert.equal(attributeTemplate("hand_made_template", "zipicka"), "unattributed");
  assert.equal(templateOwnerSlug("bulk_jp_update"), "juris-prime");
});

test("the label reads back", () => {
  assert.equal(isBulkTemplate("bulk_zp_eid_offer"), true);
  assert.equal(isBulkTemplate("staff_1a2b3c4d_offer"), false);
  assert.equal(bulkTemplateLabel("bulk_zp_eid_offer"), "eid offer");
});

test("a refusal reads as a sentence", () => {
  assert.match(explainRejection("PROMOTIONAL"), /promotional/i);
  assert.equal(explainRejection("SOMETHING_NEW"), "WhatsApp gave the reason: SOMETHING_NEW.");
});

test("waiting messages are this business's own, newest first, with WhatsApp's reason once known", () => {
  const rows = [
    { id: "1", metaTemplateName: "bulk_sfs_old", language: "en", status: "APPROVED", isApproved: true, createdAt: "2026-10-30T08:00:00Z" },
    { id: "2", metaTemplateName: "bulk_sfs_weekend_viewings", language: "en", status: "PENDING", isApproved: false, createdAt: "2026-10-30T09:00:00Z" },
    { id: "3", metaTemplateName: "bulk_zp_eid", language: "en", status: "PENDING", isApproved: false, createdAt: "2026-10-30T10:00:00Z" },
    { id: "4", metaTemplateName: "sfs_property_update", language: "en", status: "PENDING", isApproved: false, createdAt: "2026-10-30T11:00:00Z" },
    { id: "5", metaTemplateName: "bulk_sfs_big_sale", language: "en", status: "REJECTED", isApproved: false, createdAt: "2026-10-30T12:00:00Z" },
  ];
  const reviews = [{ name: "bulk_sfs_big_sale", language: "en", status: "REJECTED", rejectedReason: "PROMOTIONAL" }];
  const pending = pendingFrom(rows, "sfs-international", reviews);
  assert.deepEqual(
    pending.map((p) => [p.id, p.label, p.status]),
    [
      ["5", "big sale", "REJECTED"],
      ["2", "weekend viewings", "PENDING"],
    ]
  );
  assert.match(pending[0].reason, /promotional/i);
  assert.equal(pending[1].reason, null);
  // From the mirror alone the reason is not known yet; Check again fills it.
  assert.equal(pendingFrom(rows, "sfs-international")[0].reason, null);
});

test("the waiting list sorts the dates Postgres actually returns", () => {
  // node-postgres hands timestamptz back as Date objects, not strings: with two
  // waiting messages a string comparator threw and the number view went 500.
  const rows = [
    { id: "a", metaTemplateName: "bulk_sfs_first", language: "en", status: "PENDING", isApproved: false, createdAt: new Date("2026-10-30T09:00:00Z") },
    { id: "b", metaTemplateName: "bulk_sfs_second", language: "en", status: "PENDING", isApproved: false, createdAt: new Date("2026-10-30T10:00:00Z") },
  ];
  const pending = pendingFrom(rows, "sfs-international");
  assert.deepEqual(pending.map((p) => p.id), ["b", "a"]);
  assert.equal(pending[0].createdAt, "2026-10-30T10:00:00.000Z");
});

test("a new approved message is named for the business and written with the number's own token", () => {
  const route = read("apps", "api", "src", "routes", "admin-bulk-templates.ts");
  assert.match(route, /bulkTemplateName\(organization\.slug, label\)/);
  assert.match(route, /category: "MARKETING"/);
  assert.match(route, /language === "ar" \? "إيقاف" : "Stop"/);
  assert.match(route, /This number's WhatsApp connection cannot submit messages\. Ask its owner to reconnect it in Connections\./);
  assert.match(route, /There is already a message with that name — choose another\./);
  assert.match(route, /syncStaffAccountTemplates\(/);
  assert.match(route, /syncTemplatesForOrganization\(/);
  assert.match(read("apps", "api", "src", "index.ts"), /app\.route\("\/api\/bulk", adminBulkTemplatesRoute\);/);
  assert.match(read("apps", "api", "src", "routes", "admin-bulk.ts"), /pending: pendingFrom\(/);
});
