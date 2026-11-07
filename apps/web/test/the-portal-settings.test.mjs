// Portal settings (7 Nov 2026): an admin's window from the board — the
// agency's ORN, the Bayut/dubizzle feed address with Copy and New address and
// when Bayut last read it, each agent's BRN, and where Property Finder stands.
// Staff never see the button.
// Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §3, §6, §7, §8
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import {
  NEW_ADDRESS_WARNING,
  PortalSettingsButton,
  PortalSettingsView,
  pendingSaves,
} from "@/app/deck/workflow/board/portal-settings";

const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const noop = () => {};
const TZ = "Asia/Dubai";
const SETTINGS = {
  orn: "12345",
  feedUrl: `https://api.nexusagenticos.com/portal-feeds/${"T".repeat(43)}/bayut.xml`,
  lastReadAt: "2026-11-07T06:42:00.000Z",
  lastReadBy: "BayutBot/1.0",
  agents: [
    { id: "e1", name: "Aisha Khan", brn: "45678" },
    { id: "e2", name: "Bilal Ahmed", brn: null },
  ],
};
const view = (over = {}) =>
  render(PortalSettingsView, {
    settings: { ...SETTINGS, ...over },
    timezone: TZ,
    message: "",
    onSaveOrn: noop,
    onNewAddress: noop,
    onCopy: noop,
    onSaveBrn: noop,
  });

test("only an admin sees the Portal settings button", () => {
  assert.equal(render(PortalSettingsButton, { isAdmin: false, onOpen: noop }), "");
  assert.match(render(PortalSettingsButton, { isAdmin: true, onOpen: noop }), />Portal settings</);
});

test("the window shows the ORN, the feed address and when Bayut read it", () => {
  const html = view();
  assert.match(html, /<h2>Portal settings<\/h2>/);
  assert.match(html, /Agency ORN/);
  assert.match(html, /value="12345"/);
  assert.match(html, /<h3>Bayut and dubizzle feed<\/h3>/);
  assert.match(html, new RegExp(SETTINGS.feedUrl));
  assert.match(html, />Copy</);
  assert.match(html, />New address</);
  assert.match(html, /Last read 10:42, 7 Nov/);
  assert.match(html, /<h3>Property Finder<\/h3>/);
  assert.match(html, /Not connected yet\. It needs SFS&#x27;s Enterprise API key \(PF Expert → Developer Resources\)\./);
});

test("a feed nobody has read says so; no address yet offers to make one", () => {
  assert.match(view({ lastReadAt: null, lastReadBy: null }), /Not read yet/);
  const none = view({ feedUrl: null, lastReadAt: null, lastReadBy: null });
  assert.match(none, />Make the address</);
  assert.doesNotMatch(none, />Copy</);
});

test("a new address warns that the old one stops at once", () => {
  assert.equal(NEW_ADDRESS_WARNING, "The old address stops working at once. Bayut must be given the new one.");
});

test("each agent's BRN can be filled in", () => {
  const html = view();
  assert.match(html, /<h3>Agents&#x27; BRN<\/h3>/);
  assert.match(html, /Aisha Khan/);
  assert.match(html, /value="45678"/);
  assert.match(html, /Bilal Ahmed/);
  assert.equal(html.match(/aria-label="BRN for /g)?.length, 2);
});

test("what is still unsaved when the window closes is saved, and nothing else (final review)", () => {
  const drafts = { orn: "12345", brns: { e1: "45678", e2: "" } };
  assert.deepEqual(pendingSaves(drafts, SETTINGS), []);
  assert.deepEqual(pendingSaves({ orn: "54321", brns: { e1: "", e2: "88123" } }, SETTINGS), [
    { kind: "orn", value: "54321" },
    { kind: "brn", id: "e1", value: null },
    { kind: "brn", id: "e2", value: "88123" },
  ]);
  // An agent the window does not list is never saved.
  assert.deepEqual(pendingSaves({ orn: "12345", brns: { e9: "1" } }, SETTINGS), []);
});

test("a save does not remount the window, so what is being typed stays (final review)", () => {
  const src = readFileSync(new URL("../app/deck/workflow/board/portal-settings.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /key=\{generation\}/);
  assert.match(src, /pendingSaves\(/);
});
