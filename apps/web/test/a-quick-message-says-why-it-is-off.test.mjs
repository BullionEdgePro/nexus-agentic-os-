/**
 * A quick message says why it is off (11 Nov 2026).
 *
 * The owner ticked all 207 SFS customers on a number connected that day and
 * found "Quick message (0)" greyed out: "quick message not working". It was
 * working -- WhatsApp allows a free message only to someone who wrote in the
 * last 24 hours, and none of them had -- but the bar holding the button did not
 * say so. Now it does, next to the count, and points at the approved message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientsTab } from "../app/deck/my-campaigns/clients-tab.tsx";

const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
const never = { id: "c1", displayName: "Zak", waId: "13125206064", lastInboundAt: null };
const today = { id: "c2", displayName: "Ali Hossen", waId: "971547823988", lastInboundAt: hoursAgo(2) };

const bar = (clients, where) =>
  renderToStaticMarkup(
    createElement(ClientsTab, {
      clients,
      selected: new Set(clients.map((client) => client.id)),
      onChange: () => undefined,
      onSend: () => undefined,
      where,
    })
  );

test("with nobody inside 24 hours, the bar says why the quick message is off", () => {
  const html = bar([never], "this number");
  assert.match(html, /Quick message \(0\)/);
  assert.match(html, /none wrote to this number in the last 24 hours/);
  assert.match(html, /approved message/i);
});

test("a person's own book reads 'wrote to you'", () => {
  assert.match(bar([never], "you"), /none wrote to you in the last 24 hours/);
});

test("with someone inside 24 hours, it counts them and gives no reason", () => {
  const html = bar([never, today], "this number");
  assert.match(html, /Quick message \(1\)/);
  assert.match(html, /<strong>1<\/strong> can get a free message/);
  assert.doesNotMatch(html, /none wrote to/);
});
