/**
 * Customers in Cream (2 Nov 2026, part 2a): the list as cards with initials,
 * and a customer's profile sliding in from the side, their conversations as
 * small cards in their state's colour.
 * Spec: docs/superpowers/specs/2026-11-02-cream-pages-2a-design.md §4
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { HistoryCards, STATE_TONE } from "@/app/deck/customers/history-cards";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

test("a conversation's state has the video's colour", () => {
  assert.deepEqual(STATE_TONE, { open: "forest", pending: "mustard", resolved: "ink", closed: "ink" });
});

test("a customer's conversations are cards in their state's colour", () => {
  const html = render(HistoryCards, {
    conversations: [
      { id: "a", status: "open", channel: "whatsapp", lastMessageAt: null, messages: 3 },
      { id: "b", status: "closed", channel: "email", lastMessageAt: null, messages: 1 },
    ],
  });
  assert.match(html, /tone-forest/);
  assert.match(html, /tone-ink/);
  assert.match(html, /href="\/inbox\?conversation=a"/);
  assert.match(html, /3 messages/);
  assert.match(html, /1 message</);
  assert.match(html, /aria-label="Open conversation, 3 messages, last never\. Open the chat\."/);
  // A state this screen does not know is drawn plain, never guessed at.
  assert.match(render(HistoryCards, { conversations: [{ id: "c", status: "snoozed", lastMessageAt: null }] }), /tone-paper/);
  assert.match(render(HistoryCards, { conversations: [] }), /None with this business\./);
});

test("the profile slides in, and the admin-only export is untouched", () => {
  const P = read("app/deck/customers/page.tsx");
  assert.match(P, /<SlidePanel/);
  assert.match(P, /<HistoryCards conversations=\{selected\.conversationList\}/);
  assert.match(P, /isOperator \? \(\s*<div className="cu-export">/);
  // The list is cards with an initials badge.
  assert.match(P, /<Initials name=\{/);
  assert.match(P, /className="kit-card tone-paper cu-card"/);
  assert.doesNotMatch(P, /<section className="cu-detail">/);
});
