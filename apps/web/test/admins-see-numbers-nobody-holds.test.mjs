/**
 * Admins see WhatsApp numbers nobody holds (5 Nov 2026).
 *
 * +971 58 848 3731 (SFS) reached Nexus for a day held by nobody -- 34 customer
 * messages dropped -- and only the server's logs knew. Connections now shows an
 * admin each such number, what it cost, and how to get it back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UnheldNumbersList } from "../app/deck/my-clients/unheld-numbers.tsx";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const sfs = {
  phoneNumberId: "1273619879166296",
  displayNumber: "+971 58 848 3731",
  verifiedName: "SFS INTERNATIONAL REAL ESTATE LLC",
  firstSeen: "2026-11-05T04:03:46.000Z",
  lastSeen: "2026-11-05T09:12:00.000Z",
  messages: 34,
  receipts: 24,
};

test("each number is named, with what reached nobody and how to get it back", () => {
  const html = renderToStaticMarkup(createElement(UnheldNumbersList, { numbers: [sfs] }));
  assert.match(html, /\+971 58 848 3731/);
  assert.match(html, /SFS INTERNATIONAL REAL ESTATE LLC/);
  assert.match(html, /34 customer messages/);
  assert.match(html, /reached nobody/);
  assert.match(html, /connect WhatsApp again/i);
  assert.match(html, /Continue/);
});

test("a number Meta would not name still shows its id", () => {
  const html = renderToStaticMarkup(
    createElement(UnheldNumbersList, { numbers: [{ ...sfs, displayNumber: null, verifiedName: null, messages: 1 }] })
  );
  assert.match(html, /1273619879166296/);
  assert.match(html, /1 customer message\b/);
});

test("nothing to say, nothing shown", () => {
  assert.equal(renderToStaticMarkup(createElement(UnheldNumbersList, { numbers: [] })), "");
});

test("only an admin's Connections asks, and from the admin-only address", () => {
  const panel = read("../app/deck/my-clients/connections.tsx");
  assert.match(panel, /\{businesses \? <UnheldNumbers \/> : null\}/);
  const api = read("../lib/api.ts");
  assert.match(api, /request\("\/api\/connections\/whatsapp\/unheld"\)/);
});
