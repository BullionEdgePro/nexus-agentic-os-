/**
 * The admin front page in Cream (2 Nov 2026, part 2a): six number tiles, the
 * customers waiting longest as cards coloured by their wait, and a
 * conversations chart drawn from real days.
 * Spec: docs/superpowers/specs/2026-11-02-cream-pages-2a-design.md §2
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { WaitingCards } from "@/app/front/waiting-cards";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

test("customers waiting are cards in their wait's colour, linking to the chat, longest first", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const waiting = [
    { conversationId: "c1", contactName: "Sara Khan", employeeName: "Ralph Simeon", businessSlug: "sfs", businessName: "SFS International", since: "2026-11-01T09:00:00Z" },
    { conversationId: "c2", contactName: null, employeeName: "Keshav Arora", businessSlug: "zipicka", businessName: "Zipicka", since: "2026-11-02T11:50:00Z" },
  ];
  const html = render(WaitingCards, { waiting, total: 9, now });
  assert.ok(html.indexOf("Sara Khan") < html.indexOf("Zipicka"));
  assert.match(html, /tone-ink[^"]*"[^>]*href="\/inbox\?conversation=c1"/);
  assert.match(html, /tone-forest/);
  assert.match(html, /1 d 3 h/);
  assert.match(html, /\+7 more waiting/);
  assert.match(html, /href="\/deck\/activity"/);
  assert.match(html, /aria-label="Sara Khan at SFS International, waiting 1 d 3 h for Ralph Simeon\. Open the chat\."/);
  assert.match(render(WaitingCards, { waiting: [], total: 0, now }), /Nobody is waiting\./);
});

test("the front page uses the kit: six tiles, the waiting cards, a real conversations chart", () => {
  const P = read("app/deck-console.tsx");
  assert.match(P, /<NumberTile/);
  assert.match(P, /<WaitingCards/);
  assert.match(P, /const days = useMemo\(\s*\(\) => \(overview\?\.conversationsByDay \?\? \[\]\)/);
  assert.match(P, /<AreaChart points=\{days\}/);
  assert.doesNotMatch(P, /className="stat glass/);
  // The four quick links are ink pills; the intent bars grow in sideways.
  assert.match(P, /className="kit-pill"/);
  assert.match(P, /className="kit-hbar"/);
  assert.match(read("app/kit/kit.css"), /\.kit-hbar i \{[^}]*animation: kit-grow-x/);
});
