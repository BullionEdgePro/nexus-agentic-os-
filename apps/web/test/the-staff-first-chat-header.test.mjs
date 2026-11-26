/**
 * Staff-first compact Nexus, piece 3 (26 Nov 2026): on a phone an open chat's
 * header is one row — back, the customer, Call, Resolve, the AI / Human switch
 * and ⋯ — and ⋯ shows the rest (customer panel, Assign, Snooze, Not a
 * customer, Ask a colleague) and the labels. Wider screens: unchanged.
 * Spec: docs/superpowers/specs/2026-11-26-staff-first-chat-header-design.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the header folds its secondary controls behind ⋯, and a new chat starts folded", () => {
  const page = read("app/inbox/page.tsx");
  assert.match(page, /const \[moreOpen, setMoreOpen\] = useState\(false\);/);
  assert.match(page, /useEffect\(\(\) => \{\s*setMoreOpen\(false\);\s*\}, \[activeConversation\?\.id\]\);/);
  assert.match(page, /<header className=\{`ibx-thread-head\$\{moreOpen \? " more-open" : ""\}`\}>/);
  assert.match(page, /className=\{`ibx-iconbtn ibx-head-details\$\{detailsOpen \? " on" : ""\}`\}/);
  assert.match(page, /className="ibx-iconbtn ibx-more-btn"[\s\S]{0,200}aria-expanded=\{moreOpen\}[\s\S]{0,120}onClick=\{\(\) => setMoreOpen\(\(o\) => !o\)\}/);
});

test("on a phone only: one row, the rest and the labels under ⋯", () => {
  const css = read("app/inbox/inbox.css");
  assert.match(css, /^\.ibx-more-btn \{ display: none; \}/m);
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.ibx-more-btn \{ display: inline-grid; \}/);
  assert.match(phone, /\.ibx-thread-head:not\(\.more-open\) :is\(\.ibx-head-details, \.ibx-assignee, \.ibx-snooze, \.ibx-notcust, \.ibx-ask\) \{ display: none; \}/);
  assert.match(phone, /\.ibx-thread-head:not\(\.more-open\) \+ \.ibx-thread-tags \{ display: none; \}/);
  assert.match(phone, /\.ibx-thread-head\.more-open \.ibx-head-actions \{ flex: 1 1 100%;/);
  // Preview, 26 Nov 2026: "Sara Kh…" and a number wrapping onto two lines — the name gets
  // the room (a smaller avatar), and the number stays on one line.
  assert.match(phone, /\.ibx-thread-head \.ibx-av\.lg \{ width: 32px; height: 32px; \}/);
  assert.match(phone, /\.ibx-wa \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/);
  // The channel's name gives way to the number on a phone (the avatar's badge already says it).
  assert.match(phone, /\.ibx-wa-ch,\s*\.ibx-wa-sep \{ display: none; \}/);
  const page = read("app/inbox/page.tsx");
  assert.match(page, /<span className="ibx-wa-ch">\{channelLabel\(activeConversation\.channel\)\}<\/span>/);
  assert.match(page, /<span className="ibx-wa-sep"> · <\/span>/);
});
