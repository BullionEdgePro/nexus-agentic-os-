/**
 * A customer with a WhatsApp username shows no false number (6 Nov 2026).
 *
 * Meta identifies a customer who uses a WhatsApp username by a business-scoped
 * id ("AE.1349..."), and Nexus now keeps it where the number would be. Printed
 * as a number it read "+AE.1349...", and the inbox offered to call it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { whatsAppAddressLabel } from "@nexus/shared";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const SCREENS = [
  "../app/inbox/page.tsx",
  "../app/inbox/details-panel.tsx",
  "../app/deck/team/team-workspace.tsx",
  "../app/deck/tasks/page.tsx",
];

test("a number reads as a number; a username id reads as a username", () => {
  assert.equal(whatsAppAddressLabel("971501234567"), "+971501234567");
  assert.equal(whatsAppAddressLabel("AE.13491208655302741918"), "WhatsApp username");
});

test("no screen prints a customer's WhatsApp id with a plus of its own", () => {
  for (const screen of SCREENS) {
    // The Call button's own tel: link is shown only for a number (below).
    assert.doesNotMatch(read(screen), /(?<!tel:|Call )\+\$\{[^}]*WaId[^}]*\}/, `${screen} still writes +\${...WaId}`);
    assert.match(read(screen), /whatsAppAddressLabel\(/, screen);
  }
});

test("there is no Call button for a customer known only by username", () => {
  const inbox = read("../app/inbox/page.tsx");
  const call = inbox.slice(inbox.indexOf('className="ibx-callbtn"') - 400, inbox.indexOf('className="ibx-callbtn"'));
  assert.match(call, /!isBusinessScopedUserId\(activeConversation\.contactWaId\)/);
});
