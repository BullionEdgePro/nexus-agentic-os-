/**
 * The approved-message picker on Bulk messaging (3 Nov 2026) showed WhatsApp's
 * code names ("bulk_zp_weekend_viewings (en)", "staff_50667769_offer (en)").
 * It now shows the words the admin gave the message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { templateOptionLabel } from "../lib/template-option-label.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(here, "..", "app", "deck", "bulk", "page.tsx"), "utf8");

test("an admin's own message shows the short name it was given", () => {
  assert.equal(templateOptionLabel("bulk_zp_weekend_viewings", "en"), "Weekend viewings (en)");
});

test("a business's own and a staff member's messages read as words too", () => {
  assert.equal(templateOptionLabel("zipicka_order_update", "en"), "Zipicka order update (en)");
  assert.equal(templateOptionLabel("staff_50667769_offer", "ar"), "Offer (ar)");
});

test("the picker uses it", () => {
  assert.match(PAGE, /\{templateOptionLabel\(template\.name, template\.language\)\}/);
});
