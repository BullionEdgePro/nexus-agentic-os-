// The inbox on a phone (spec 2026-10-09-nexus-mobile-app-design.md, unit 2).
// Below 760px the inbox already showed the list OR the open chat. What a phone
// still needed: a link (a notification tap) that opens only a chat the person
// can actually see; the system back gesture returning to the list instead of
// leaving the app; the composer staying above the keyboard; the notch and home
// bar respected; thumb-sized buttons; and the customer drawer full width.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const PAGE = read("apps", "web", "app", "inbox", "page.tsx");
const CSS = read("apps", "web", "app", "inbox", "inbox.css");

/** The body of the `@media (max-width: 760px)` block(s), concatenated. */
function phoneCss() {
  const out = [];
  let at = CSS.indexOf("@media (max-width: 760px)");
  while (at > -1) {
    let depth = 0;
    let i = CSS.indexOf("{", at);
    const start = i;
    for (; i < CSS.length; i++) {
      if (CSS[i] === "{") depth++;
      else if (CSS[i] === "}" && --depth === 0) break;
    }
    out.push(CSS.slice(start, i));
    at = CSS.indexOf("@media (max-width: 760px)", i);
  }
  assert.ok(out.length > 0, "no phone media block found");
  return out.join("\n");
}

test("a link to a chat opens it only if it is in this person's list", () => {
  // A notification tap or a shared link must never open a chat the signed-in
  // person cannot see; it waits for their own list and drops an unknown id.
  assert.ok(!/if \(conversation\) selectConversation\(conversation\);/.test(PAGE), "the link no longer selects blindly");
  assert.match(PAGE, /pendingConversation\.current = conversation;/);
  assert.match(PAGE, /conversations\.some\(\(c\) => c\.id === pending\)/);
});

test("the phone's back gesture returns to the list, not out of the app", () => {
  assert.match(PAGE, /window\.matchMedia\("\(max-width: 760px\)"\)\.matches/);
  assert.match(PAGE, /history\.pushState\(\{ nexusThread: selectedConversationId \}/);
  assert.match(PAGE, /addEventListener\("popstate"/);
  assert.match(PAGE, /closeConversation\(\)/);
});

test("the open chat keeps the composer above the keyboard", () => {
  assert.match(PAGE, /window\.visualViewport/);
  assert.match(PAGE, /setProperty\("--vvh"/);
  assert.match(phoneCss(), /\.ibx\.has-thread \{[^}]*height: var\(--vvh, 100dvh\)/);
});

test("the notch, the home bar and thumbs are respected", () => {
  const phone = phoneCss();
  assert.match(phone, /\.ibx-compose-wrap \{[^}]*env\(safe-area-inset-bottom/);
  assert.match(phone, /\.ibx-thread-head \{[^}]*env\(safe-area-inset-top/);
  assert.match(phone, /\.ibx-iconbtn \{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
  assert.match(phone, /\.ibx-details \{[^}]*width: 100vw;/);
});
