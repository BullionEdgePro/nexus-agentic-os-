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
  PF_DISCONNECT_WARNING,
  PfSection,
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
  propertyFinder: { saved: false, environment: null, keyEnding: null, checkedAt: null, checkError: null, listingCallsReady: false },
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
    onSavePfKey: noop,
    onCheckPf: noop,
    onDisconnectPf: noop,
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
  assert.match(html, /A Decision Maker opens PF Expert → Developer Resources → API Credentials → New API Key\. Start with a Sandbox\./);
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

// Property Finder's key (7 Nov 2026).
// Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §6
const PF_NONE = SETTINGS.propertyFinder;
const PF_SAVED = { saved: true, environment: "sandbox", keyEnding: "1a2b", checkedAt: "2026-11-07T06:42:00.000Z", checkError: null, listingCallsReady: false };
const pfView = (pf) => render(PfSection, { pf, timezone: TZ, onSaveKey: noop, onCheck: noop, onDisconnect: noop });

test("with no key saved, the steps and the fields to enter one", () => {
  const html = pfView(PF_NONE);
  assert.match(html, /A Decision Maker opens PF Expert → Developer Resources → API Credentials → New API Key\. Start with a Sandbox\./);
  assert.match(html, /aria-label="API key"/);
  assert.match(html, /<input[^>]*type="password"[^>]*aria-label="API secret"|<input[^>]*aria-label="API secret"[^>]*type="password"/);
  assert.match(html, /autoComplete="off"|autocomplete="off"/);
  assert.match(html, />Sandbox</);
  assert.match(html, />Live</);
  assert.match(html, />Save and check</);
  assert.doesNotMatch(html, />Disconnect</);
});

test("a saved key shows its ending, environment and check time, never the key", () => {
  const html = pfView(PF_SAVED);
  assert.match(html, /Connected \(Sandbox\) — key ending 1a2b, checked 10:42, 7 Nov/);
  assert.match(pfView({ ...PF_SAVED, environment: "live" }), /Connected \(Live\) — key ending 1a2b/);
  assert.match(html, /Listings start going to Property Finder once its listing format is added to Nexus\./);
  for (const b of ["Check again", "Replace key", "Disconnect"]) assert.match(html, new RegExp(`>${b}<`), b);
  assert.doesNotMatch(html, /aria-label="API secret"/, "the fields wait for Replace key");
  assert.doesNotMatch(pfView({ ...PF_SAVED, listingCallsReady: true }), /once its listing format is added/);
});

test("browsers are told the secret is not a login to save (final review)", () => {
  // A text field then a password field looks like a sign-in form; "off" is
  // ignored on password fields, so the browser would offer to save the Property
  // Finder secret as the Nexus password and fill it into the sign-in page.
  const html = pfView(PF_NONE);
  const secret = html.match(/<input[^>]*aria-label="API secret"[^>]*>/)[0];
  assert.match(secret, /autocomplete="new-password"/i);
});

test("a refused key shows the refusal", () => {
  const html = pfView({ ...PF_SAVED, checkError: "Property Finder refused the key: invalid client" });
  assert.match(html, /Property Finder refused the key: invalid client/);
  assert.doesNotMatch(html, /Connected \(/);
});

test("the secret is emptied after saving, and disconnect asks first", () => {
  const src = readFileSync(new URL("../app/deck/workflow/board/portal-settings.tsx", import.meta.url), "utf8");
  const save = src.slice(src.indexOf("onSaveKey({"));
  assert.match(save.slice(0, 400), /setApiSecret\(""\)/);
  assert.match(save.slice(0, 400), /setApiKey\(""\)/);
  assert.equal(PF_DISCONNECT_WARNING, "Nexus stops updating Property Finder. Listings already there stay until removed in PF Expert.");
  assert.match(src, /window\.confirm\(PF_DISCONNECT_WARNING\)/);
});
