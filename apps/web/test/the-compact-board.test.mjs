/**
 * The compact board (25 Nov 2026): steps that hold cards come first and wrap
 * on the screen; empty steps fold into a row of small chips that stay drop
 * targets; five hot leads, then "Show all (N)"; the "Runs by itself" counts as
 * one line; a one-line header with the explanation behind an ⓘ.
 * Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §3
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { REAL_ESTATE_WORKFLOW, boardColumns } from "@nexus/shared";
import { WorkflowBoardView } from "@/app/deck/workflow/board/board-view";
import { splitColumns, HOT_SHOWN } from "@/lib/workflow/board-layout";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const NOW = Date.parse("2026-11-25T12:00:00Z");
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();
const ME = { id: "e1", name: "Atif Ali" };

const unit = (over) => ({
  kind: "unit", id: "u0", step: "S5", inStepSince: ago(0), reference: "Unit", community: null, propertyType: null,
  bedrooms: null, purpose: null, priceAed: null, cheques: null, ejariReady: false, titleDeed: false, ownerDocs: false,
  formASignedOn: null, permitNumber: null, permitExpiresOn: null, liveOn: [], owner: null, agent: ME, notes: null,
  dealIds: [], updatedAt: ago(0), title: null, description: null, sizeSqft: null, bathrooms: null, furnishing: null,
  city: "Dubai", subCommunity: null, building: null, parking: null, amenities: [], availableFrom: null, photos: [],
  portals: { bayut: { wanted: false }, dubizzle: { wanted: false }, property_finder: { wanted: false } },
  bayutLocation: null, pocket: { on: false, since: null, shares: [] },
  ...over,
});
const hot = (n) => Array.from({ length: n }, (_, i) => ({ contactId: `c${i}`, name: `Lead ${i + 1}`, priority: "high", scoredAt: ago(i) }));

const BOARD = {
  viewer: { employeeId: "e1", seesAll: false },
  units: [unit({ id: "u1", step: "S6", reference: "Marina Gate 2 · 1204" })],
  deals: [],
  hidden: { D5: 2 },
  hotWaiting: hot(7),
  closed30: { let: 0, sold: 0, won: 0, commissionAed: 0 },
  today: "2026-11-25",
  portalFeed: null,
  ornSet: false,
  agentBrns: {},
};
const AUDIT = {
  business: { slug: "sfs-international", name: "SFS International", timezone: "Asia/Dubai" },
  period: { days: 30, from: "2026-10-05", today: "2026-11-03", bucket: "day" },
  evidence: {
    contacts: { total: 154, added: 12, withSource: 97, optedOut: 3, notACustomer: 5, emailOptedOut: 1 },
    outreach: { sent: 40, delivered: 38, failed: 2 },
    calls: { answered: 4, noAnswer: 3, voicemail: 1, busy: 0, failed: 0 },
    reengagement: { sent: 6, replied: 2, optedOut: 1, inCooldown: 4 },
    leads: { total: 88, pitches: 2, byChannel: { whatsapp: 80 }, bySource: [{ source: "Bayut", count: 30 }] },
    qualifier: { scored: 59, hot: 12 },
    replies: { medianMs: 300000, byAi: 50, byPerson: 30, unanswered: 7 },
    viewings: { booked: 6, held: 4, noShow: 1, cancelled: 1 },
    won: 2,
    followUps: { created: 9, done: 5, openNow: 4, overdueNow: 2 },
    board: {},
    permits: { advertised: 2, expired: 1 },
  },
  series: { leads: [], replyMedian: [], quality: [], viewings: [] },
  funnel: { leads: 88, scored: 59, hot: 12, booked: 6, held: 4, won: 2 },
};
const view = (over = {}) =>
  renderToStaticMarkup(
    createElement(WorkflowBoardView, {
      workflow: REAL_ESTATE_WORKFLOW, board: BOARD, audit: null, now: NOW,
      onMove: async () => {}, onOpen: () => {}, onAdd: () => {}, ...over,
    })
  );

test("splitColumns puts the steps holding cards first, the rest in workflow order", () => {
  const columns = boardColumns(REAL_ESTATE_WORKFLOW, "supply");
  const { filled, empty } = splitColumns(columns, BOARD.units, {});
  assert.deepEqual(filled.map((s) => s.id), ["S6"]);
  assert.deepEqual(empty.map((s) => s.id), columns.map((s) => s.id).filter((id) => id !== "S6"));
});

test("a step with colleagues' deals counts as holding cards", () => {
  const columns = boardColumns(REAL_ESTATE_WORKFLOW, "demand");
  const { filled } = splitColumns(columns, [], { D5: 2 });
  assert.deepEqual(filled.map((s) => s.id), ["D5"]);
});

test("five hot leads show, then Show all (N)", () => {
  assert.equal(HOT_SHOWN, 5);
  const html = view();
  for (let i = 1; i <= 5; i++) assert.match(html, new RegExp(`Lead ${i}<`));
  assert.doesNotMatch(html, /Lead 6</);
  assert.match(html, /Show all \(7\)/);
  assert.doesNotMatch(view({ board: { ...BOARD, hotWaiting: hot(3) } }), /Show all/);
});

test("empty steps fold into one row of chips that are still drop targets", () => {
  const html = view();
  const row = html.slice(html.indexOf("wf-board-empty-steps"));
  assert.match(html, /class="wf-board-empty-steps[^"]*"/);
  assert.match(row, /Empty steps/);
  assert.match(row, /data-column="S5"/);
  assert.doesNotMatch(row.slice(0, row.indexOf("</section></div>") + 1 || undefined), /data-column="S6"/);
  assert.doesNotMatch(html, /nothing here/);
});

test("the steps run by themselves are one line per lane", () => {
  const html = view({ audit: AUDIT });
  assert.equal((html.match(/class="wf-board-auto-line"/g) ?? []).length, 2);
  assert.match(html, /Runs by itself · 30 days:/);
});

test("the lanes wrap on the screen: no sideways scroll", () => {
  const css = read("app/deck/workflow/workflow.css");
  const rule = css.match(/\.wf-board-lane \{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /auto-fill/);
  assert.doesNotMatch(rule, /overflow-x: auto/);
});

test("the header is one line, the explanation behind an ⓘ", () => {
  const page = read("app/deck/workflow/page.tsx");
  assert.match(page, /aria-label="About this page"/);
  assert.match(page, /aria-expanded=\{about\}/);
  assert.match(page, /\{about \? \(/);
});

// ---- Task 3: Mine, Only mine, a card opened by link ----------------------------------------
import { isMine } from "@/lib/workflow/board-layout";

const COLLEAGUE = { id: "e2", name: "Bilal" };

test("isMine: the viewer's own cards only, and never for a viewer with no employee record", () => {
  const mine = unit({ id: "m1" });
  const theirs = unit({ id: "t1", agent: COLLEAGUE });
  assert.equal(isMine(mine, { employeeId: "e1", seesAll: false }), true);
  assert.equal(isMine(theirs, { employeeId: "e1", seesAll: false }), false);
  assert.equal(isMine(mine, { employeeId: null, seesAll: false }), false);
  assert.equal(isMine(unit({ id: "n1", agent: null }), { employeeId: "e1", seesAll: false }), false);
});

test("a staff member's own card is tagged Mine and listed first in its step", () => {
  const board = {
    ...BOARD,
    units: [
      unit({ id: "t1", step: "S6", reference: "Theirs", agent: COLLEAGUE, inStepSince: ago(9) }),
      unit({ id: "m1", step: "S6", reference: "Mine one", inStepSince: ago(1) }),
    ],
  };
  const html = view({ board });
  const step = html.slice(html.indexOf('data-column="S6"'));
  assert.ok(step.indexOf("Mine one") >= 0 && step.indexOf("Mine one") < step.indexOf("Theirs"), "mine first in its step");
  assert.match(html, /class="wf-board-mine"[^>]*>Mine</);
  assert.equal((html.match(/class="wf-board-mine"/g) ?? []).length, 1);
});

test("Only mine hides a colleague's cards", () => {
  const board = { ...BOARD, units: [unit({ id: "t1", step: "S6", reference: "Theirs", agent: COLLEAGUE }), unit({ id: "m1", step: "S7", reference: "Mine one" })] };
  const html = view({ board, onlyMine: true });
  assert.match(html, /Mine one/);
  assert.doesNotMatch(html, /Theirs/);
});

test("the Only mine switch is for staff only, and ?card= opens a card the board holds", () => {
  const panel = read("app/deck/workflow/board/board-panel.tsx");
  assert.match(panel, /Only mine/);
  assert.match(panel, /!board\.viewer\.seesAll/);
  assert.match(panel, /new URLSearchParams\(window\.location\.search\)\.get\("card"\)/);
  assert.match(panel, /\[\.\.\.board\.units, \.\.\.board\.deals\]\.find\(\(c\) => c\.id === wanted\)/);
  assert.match(panel, /if \(card\) \{\s*setOpened\(\{ id: card\.id, el: null \}\);/);
});

test("the page header is never the hidden arrow-head class (preview, 25 Nov 2026)", () => {
  // `.wf-head` is the lanes' SVG arrow head (opacity 0 until drawn); a header carrying it vanished.
  const page = read("app/deck/workflow/page.tsx");
  assert.match(page, /<header className="act-head wf-title">/);
  assert.doesNotMatch(page, /className="[^"]*\bwf-head\b/);
});

test("a link with ?card= or ?view=board lands on the Board tab", () => {
  const page = read("app/deck/workflow/page.tsx");
  assert.match(page, /params\.has\("card"\) \|\| params\.get\("view"\) === "board"/);
  assert.match(page, /<WorkflowPanel key=\{slug\} slug=\{slug\} initialView=\{view\} \/>/);
});

// ---- Final review (25 Nov 2026): a drop on an empty step lands (C1); only the dragged lane opens (I3) ----
import * as layout from "@/lib/workflow/board-layout";

const deal = (over) => ({
  kind: "deal", id: "d0", step: "D5", inStepSince: ago(0), contact: { id: "c1", name: "Ahmed K." },
  purpose: "rent", budgetAed: null, offerAed: null, ejariNumber: null, kycDone: false, formFSignedOn: null,
  dldTransferOn: null, dealValueAed: null, commissionAed: null, agent: ME, notes: null, unitIds: [], nextViewingAt: null,
  ...over,
});

/** The <div> that opens at `at`, through its own closing tag (React escapes "<" and ">" in text and attributes). */
function divAt(html, at) {
  const tag = /<(\/?)div\b[^>]*>/g;
  tag.lastIndex = at;
  let depth = 0;
  for (let m; (m = tag.exec(html)); ) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(at, tag.lastIndex);
  }
  return html.slice(at);
}
/** What the kit clips a drag to: the innermost .kit-board around the markup at `at` (kit/board.tsx, closest(".kit-board")). */
function closestKitBoard(html, at) {
  const tag = /<(\/?)div\b([^>]*)>/g;
  const open = [];
  for (let m; (m = tag.exec(html)) && m.index < at; ) {
    if (m[1]) open.pop();
    else open.push({ at: m.index, kit: /\bclass="(?:[^"]*\s)?kit-board(?:\s[^"]*)?"/.test(m[2]) });
  }
  const hit = open.reverse().find((o) => o.kit);
  return hit ? divAt(html, hit.at) : null;
}
const columnIds = (html) => [...html.matchAll(/data-column="([^"]+)"/g)].map((m) => m[1]).sort();
const laneIds = (lane) => boardColumns(REAL_ESTATE_WORKFLOW, lane).map((s) => s.id).sort();

test("an empty step takes a drop: every step of a card's lane sits inside the board its drag is clipped to", () => {
  // The kit takes a drop only on columns inside the dragged card's closest(".kit-board")
  // (kit/board.tsx columnBoxes + visibleBoxes): a chip row beside that box never took one.
  assert.match(read("app/kit/board.tsx"), /scroller: el\.closest<HTMLElement>\("\.kit-board"\)/);
  const html = view({ board: { ...BOARD, deals: [deal({ id: "d1", step: "D4" })] } });
  for (const [id, lane] of [["u1", "supply"], ["d1", "demand"]]) {
    const at = html.indexOf(`data-card="${id}"`);
    assert.ok(at >= 0, `card ${id} is drawn`);
    const box = closestKitBoard(html, at);
    assert.ok(box, `card ${id} sits in a .kit-board`);
    assert.deepEqual(columnIds(box), laneIds(lane), `${lane}: every step inside the board ${id} drags in`);
  }
  const supply = view();
  assert.ok(supply.indexOf('data-column="S6"') < supply.indexOf('class="wf-board-empty-steps'), "steps holding cards first");
});

test("a lane with no cards still has its board, every step a chip inside it", () => {
  const html = view({ board: { ...BOARD, units: [], deals: [], hidden: {} } });
  const boxes = [...html.matchAll(/<div class="kit-board wf-board-lane"[^>]*>/g)].map((m) => divAt(html, m.index));
  assert.equal(boxes.length, 2, "one board per lane");
  ["supply", "demand"].forEach((lane, i) => {
    assert.match(boxes[i], /class="wf-board-empty-steps"/);
    assert.deepEqual(columnIds(boxes[i]), laneIds(lane));
  });
});

test("the Empty steps row is the lane grid's last row, full width", () => {
  const css = read("app/deck/workflow/workflow.css");
  assert.match(css, /\.wf-board-lane > \.wf-board-empty-steps \{[^}]*grid-column: 1 \/ -1;/);
});

test("only the dragged card's own lane opens its empty steps", () => {
  const { draggedLane } = layout;
  assert.equal(typeof draggedLane, "function", "board-layout exports no draggedLane");
  const cards = [unit({ id: "u1", step: "S6" }), deal({ id: "d1" })];
  assert.equal(draggedLane(cards, "u1"), "supply");
  assert.equal(draggedLane(cards, "d1"), "demand");
  assert.equal(draggedLane(cards, null), null);
  assert.equal(draggedLane(cards, "gone"), null);
  const V = read("app/deck/workflow/board/board-view.tsx");
  assert.match(V, /const dragLane = draggedLane\(cards, drag\.dragging\);/);
  assert.match(V, /`wf-board-empty-steps\$\{dragLane === lane \? " dragging" : ""\}`/);
  assert.doesNotMatch(V, /wf-board-empty-steps\$\{drag\.dragging \?/);
});

test("the Hot leads box is only as tall as its leads", () => {
  // Final review: `flex: 1 1 260px` was a width in the old wrapping row; in the lane's
  // column it made the box at least 260px tall, a large empty frame over one or two leads.
  const css = read("app/deck/workflow/workflow.css");
  const rules = css.match(/\.wf-board-hot \{[^}]*\}/g) ?? [];
  assert.ok(rules.length > 0);
  for (const rule of rules) assert.doesNotMatch(rule, /flex:/);
});
