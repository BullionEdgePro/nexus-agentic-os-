/**
 * Phone notifications, the panel (phone push, 4 Nov 2026; mobile plan Task 11).
 *
 * Nothing ever let a person turn alerts on, so no phone was ever told anything.
 * Staff get it in My settings, admins on Notifications. An iPhone Safari tab has
 * no push at all until Nexus is on the Home Screen, so it is told how instead
 * of shown a button that cannot work; a server without its keys says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PhoneAlertsView } from "@/app/deck/phone-alerts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const noop = () => undefined;
const render = (over = {}) =>
  renderToStaticMarkup(
    createElement(PhoneAlertsView, {
      role: "employee",
      supported: true,
      configured: true,
      devices: [],
      thisDeviceId: null,
      busy: null,
      note: null,
      onTurnOn: noop,
      onChange: noop,
      onRemove: noop,
      onTest: noop,
      ...over,
    })
  );
const device = (over = {}) => ({ id: "d1", label: "iPhone", previews: false, mode: "mine", lastSuccessAt: null, failureCount: 0, ...over });

test("an iPhone tab is told to install Nexus first, with no button that cannot work", () => {
  const html = render({ supported: false });
  assert.match(html, /Install Nexus to your Home Screen first, then turn notifications on here\./);
  assert.match(html, /Add to Home Screen/);
  assert.doesNotMatch(html, /Turn on alerts/);
});

test("a server without its keys says so", () => {
  const html = render({ configured: false });
  assert.match(html, /Notifications aren(&#x27;|')t enabled on this server yet\./);
  assert.doesNotMatch(html, /Turn on alerts/);
});

test("a phone not yet set up is offered the switch", () => {
  assert.match(render(), /Turn on alerts on this phone/);
});

test("a working phone says it works and when it last heard", () => {
  const html = render({ devices: [device({ lastSuccessAt: new Date(Date.now() - 5 * 60_000).toISOString() })], thisDeviceId: "d1" });
  assert.match(html, /Working/);
  assert.match(html, /last delivered 5 min ago/);
  assert.doesNotMatch(html, /Turn on alerts on this phone/, "this phone is already on");
});

test("a phone that keeps failing says so", () => {
  assert.match(render({ devices: [device({ failureCount: 5 })] }), /This phone stopped receiving/);
});

test("message text is off until the person turns it on", () => {
  const html = render({ devices: [device()] });
  assert.match(html, /Show message text/);
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
});

test("staff choose between their chats and pause; admins can also hear every new chat", () => {
  const staff = render({ devices: [device()] });
  assert.match(staff, /My chats/);
  assert.match(staff, /Paused/);
  assert.doesNotMatch(staff, /Every new chat nobody has taken/);
  assert.match(render({ role: "operator", devices: [device()] }), /Every new chat nobody has taken/);
});

test("each phone can be tested and removed", () => {
  const html = render({ devices: [device(), device({ id: "d2", label: "Android" })] });
  assert.equal(html.match(/>Remove</g)?.length, 2);
  assert.equal(html.match(/>Send a test</g)?.length, 2);
  assert.match(html, /Android/);
});

test("one Notifications page for everyone, with the choices that fit who is signed in; staff also in My settings", () => {
  assert.match(read("app/deck/my-settings/page.tsx"), /<PhoneAlerts role="employee" \/>/);
  const page = read("app/deck/notifications/page.tsx");
  assert.match(page, /<PhoneAlerts role=\{me\.role === "employee" \? "employee" : "operator"\} \/>/);
  const nav = read("lib/nav.tsx");
  const at = nav.indexOf('href: "/deck/notifications"');
  const entry = nav.slice(at, nav.indexOf("href:", at + 10));
  assert.doesNotMatch(entry, /operatorOnly|staffOnly/, "both roles turn their own alerts on");
  assert.match(nav, /\{ title: "You", hrefs: \[[^\]]*"\/deck\/notifications"/);
});

test("the page talks to /api/me/push only", () => {
  const api = read("lib/api.ts");
  for (const fn of ["getPushDevices", "registerPushDevice", "updatePushDevice", "removePushDevice", "testPushDevice"]) {
    const body = api.slice(api.indexOf(`export function ${fn}(`), api.indexOf(`export function ${fn}(`) + 400);
    assert.match(body, /\/api\/me\/push/, fn);
  }
});

test("the install banner shows the iPhone steps instead of a page that does not exist", () => {
  const banner = read("app/install-app.tsx");
  assert.doesNotMatch(banner, /href="\/app#iphone"/);
  assert.match(banner, /Add to Home Screen/);
});
