// Removing a catalogue item takes it out of the agent (audit, 4 Nov 2026).
//
// "Remove" stamped the install and turned the card back to Install -- and left
// the pack's knowledge indexed, so the agent kept quoting it, and a procedure or
// wording that had been switched on kept steering replies. The function's own
// comment said removing something switched on switches it off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CATALOG = readFileSync(new URL("../../../packages/db/src/catalog.ts", import.meta.url), "utf8");
const remove = CATALOG.slice(CATALOG.indexOf("export async function removeCatalogInstall("));
const body = remove.slice(0, remove.indexOf("\n}\n") + 3);

test("its procedure and its wording are switched off", () => {
  assert.match(body, /update procedures set is_active = false\s+where catalog_install_id = \$1/);
  assert.match(body, /update agent_phrases set is_active = false\s+where catalog_install_id = \$1/);
});

test("its knowledge leaves the business's knowledge base", () => {
  assert.match(body, /delete from knowledge_sources\s+where organization_id = \$1 and uri = 'catalog:' \|\| \$2/);
});
