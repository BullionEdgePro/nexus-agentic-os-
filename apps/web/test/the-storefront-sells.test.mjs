/**
 * The storefront in Cream, part 3 (spec 2026-11-02-storefront-cream-design.md):
 * a product site that wins other businesses, with WhatsApp as the way in and
 * email until the sales number is set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { salesContact, SALES_TEXT } from "@/lib/sales-contact";
import { ContactButton } from "@/app/landing-contact";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

test("a sales number becomes a WhatsApp link with the prefilled hello", () => {
  const c = salesContact("971501234567");
  assert.equal(c.kind, "whatsapp");
  assert.equal(c.href, `https://wa.me/971501234567?text=${encodeURIComponent(SALES_TEXT)}`);
  assert.equal(SALES_TEXT, "Hi Nexus, I'd like to see how it works for my business");
});

test("a number typed the human way still works; anything else falls back to email", () => {
  for (const raw of ["+971 50 123 4567", " 971-50-1234567 ", "+971501234567"]) {
    assert.equal(salesContact(raw).href.split("?")[0], "https://wa.me/971501234567", raw);
  }
  assert.equal(salesContact("00971501234567").href.split("?")[0], "https://wa.me/971501234567");
  for (const raw of [undefined, "", "   ", "call us", "12345", "1234567890123456"]) {
    const c = salesContact(raw);
    assert.equal(c.kind, "email", String(raw));
    assert.match(c.href, /^mailto:jurishostinger11@gmail\.com/);
  }
});

test("the button says where it goes", () => {
  const wa = render(ContactButton, { contact: salesContact("971501234567"), whatsappLabel: "Chat on WhatsApp" });
  assert.match(wa, /href="https:\/\/wa\.me\/971501234567\?text=/);
  assert.match(wa, />Chat on WhatsApp</);
  assert.match(wa, /target="_blank"/);
  assert.match(wa, /rel="noopener"/);
  const mail = render(ContactButton, { contact: salesContact(undefined), whatsappLabel: "Chat on WhatsApp" });
  assert.match(mail, />Email us</);
  assert.doesNotMatch(mail, /target=/);
});

test("the storefront reads the number on the server, per request", () => {
  const P = read("app/page.tsx");
  assert.match(P, /export const dynamic = "force-dynamic"/);
  assert.match(P, /<Landing contact=\{salesContact\(process\.env\.NEXUS_SALES_WHATSAPP\)\} \/>/);
});
