/**
 * The workflow board on screen (3 Nov 2026): two lanes of steps, cards that
 * drag by finger or mouse and move by menu for everyone, what each step needs,
 * and the board's honest figures. Rendered with React's server renderer.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §2, §9
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { REAL_ESTATE_WORKFLOW } from "@nexus/shared";
import { WorkflowBoardView, boardCanDrop } from "@/app/deck/workflow/board/board-view";
import { MoveMenu } from "@/app/deck/workflow/board/move-menu";
import { WorkflowPanel } from "@/app/deck/workflow/panel";
import { CardDetail, draftOf, unsavedChanges } from "@/app/deck/workflow/board/card-detail";
import { AddCard, toAed } from "@/app/deck/workflow/board/add-card";
import { readableError } from "@/lib/api";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const render = (component, props) => renderToStaticMarkup(createElement(component, props));

const NOW = Date.parse("2026-11-03T12:00:00Z");
const ago = (days) => new Date(NOW - days * 86_400_000 - 3_600_000).toISOString();
const AISHA = { id: "e1", name: "Aisha Khan" };

const unit = (over) => ({
  kind: "unit", id: "u0", step: "S5", inStepSince: ago(0), reference: "Unit", community: null, propertyType: null,
  bedrooms: null, purpose: null, priceAed: null, cheques: null, ejariReady: false, titleDeed: false, ownerDocs: false,
  formASignedOn: null, permitNumber: null, permitExpiresOn: null, liveOn: [], owner: null, agent: AISHA, notes: null,
  dealIds: [], ...over,
});
const deal = (over) => ({
  kind: "deal", id: "d0", step: "D4", inStepSince: ago(0), contact: { id: "c1", name: "Lead one" }, purpose: "rent",
  budgetAed: null, offerAed: null, ejariNumber: null, kycDone: false, formFSignedOn: null, dldTransferOn: null,
  dealValueAed: null, commissionAed: null, agent: AISHA, notes: null, unitIds: [], nextViewingAt: null, ...over,
});
const permit = { formASignedOn: "2026-01-01", permitNumber: "71234" };

const BOARD = {
  units: [
    unit({ id: "u1", reference: "Marina Gate 2 · 1204", inStepSince: ago(3) }),
    unit({ id: "u2", step: "S9", purpose: "rent", priceAed: 95000, reference: "JLT Cluster X · 805", inStepSince: ago(9), ...permit, permitExpiresOn: "2026-11-02" }),
    unit({ id: "u3", step: "S10", purpose: "sale", priceAed: 1200000, reference: "Palm villa 12", inStepSince: ago(1), ...permit, permitExpiresOn: "2026-11-08", liveOn: ["bayut"] }),
  ],
  deals: [deal({ id: "d1", step: "D5", inStepSince: ago(21), budgetAed: 90000, nextViewingAt: "2026-11-05T12:00:00Z" })],
  hidden: { D5: 2 },
  hotWaiting: [{ contactId: "c9", name: "Hot lead", priority: "urgent", scoredAt: ago(0) }],
  closed30: { let: 1, sold: 2, won: 3, commissionAed: 84000 },
  today: "2026-11-03",
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
  render(WorkflowBoardView, {
    workflow: REAL_ESTATE_WORKFLOW,
    board: BOARD,
    audit: AUDIT,
    now: NOW,
    onMove: async () => {},
    onOpen() {},
    onAdd() {},
    ...over,
  });

test("the board's columns are the steps that take cards; the first steps stay automatic", () => {
  const html = view();
  const columns = [...html.matchAll(/data-column="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(columns, ["S5", "S6", "S7", "S8", "S9", "S10", "D3", "D4", "D5", "D6", "D7", "D8", "D9"]);
  // Owner database … Nurture and New lead, AI qualifier: counts from the audit, never a drop target.
  assert.match(html, /class="wf-board-auto"/);
  assert.match(html, /Owner database/);
  assert.match(html, /Contacts in total<\/span> <b>154<\/b>/);
  assert.match(html, /New leads<\/span> <b>88<\/b>/);
  assert.match(html, /the last 30 days/);
});

test("hot leads wait in the qualifier's strip until someone puts them on the board", () => {
  const html = view();
  assert.match(html, /Hot leads not on the board/);
  assert.match(html, /Hot lead/);
  assert.match(html, />Put on the board</);
  assert.doesNotMatch(view({ board: { ...BOARD, hotWaiting: [] } }), /Hot leads not on the board/);
});

test("a colleague's deals are counted on their step, never named", () => {
  const html = view();
  assert.match(html, /\+2 with colleagues/);
  assert.equal((html.match(/with colleagues/g) ?? []).length, 1);
});

test("cards show the permit, the days in the step, and what is missing", () => {
  const html = view();
  // The lapsed permit is the business's date (board.today), not the browser's clock.
  assert.match(html, /class="wf-board-badge wf-board-expired"[^>]*>Permit expired</);
  assert.match(html, /class="wf-board-badge wf-board-expiring"[^>]*>Permit expires in 5 days</);
  assert.match(html, /AK · 3 days/);
  assert.match(html, /AK · 21 days/);
  assert.match(html, /To let · AED 95,000/);
  assert.match(html, /For sale · AED 1,200,000/);
  assert.match(html, /Not classified yet/);
  assert.match(html, /Renting · budget AED 90,000/);
  assert.match(html, /Viewing 5 Nov/);
  // Marina Gate has nothing filled in for Classify unit; Palm villa is live on a portal.
  assert.match(html, /aria-label="Marina Gate 2 · 1204[^"]*Something this step needs is missing/);
  assert.doesNotMatch(html, /aria-label="Palm villa 12[^"]*Something this step needs is missing/);
  const later = view({ board: { ...BOARD, today: "2026-10-01" } });
  assert.doesNotMatch(later, /Permit expired/);
});

test("the header: closed in the last 30 days, and the cards waiting longest", () => {
  const html = view();
  assert.match(html, /Closed in the last 30 days/);
  assert.match(html, /<dt>Let<\/dt><dd>1<\/dd><dt>Sold<\/dt><dd>2<\/dd><dt>Won<\/dt><dd>3<\/dd><dt>Commission<\/dt><dd>AED 84,000<\/dd>/);
  const waiting = html.slice(html.indexOf("Waiting longest"));
  const order = ["Lead one", "JLT Cluster X · 805", "Marina Gate 2 · 1204"].map((t) => waiting.indexOf(t));
  assert.ok(order.every((i) => i > 0), "all three wait");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.doesNotMatch(waiting.slice(0, waiting.indexOf("</ol>")), /Palm villa 12/);
});

test("Move to… lists the drawn next steps first, and says why a step is shut", () => {
  const html = render(MoveMenu, { workflow: REAL_ESTATE_WORKFLOW, card: BOARD.units[0], today: BOARD.today, onMove() {} });
  assert.match(html, /Move to…/);
  const at = (s) => html.indexOf(s);
  assert.ok(at("Next:") < at(">Rent units<") && at(">Rent units<") < at(">Sale units<"));
  assert.ok(at(">Sale units<") < at("Another step") && at("Another step") < at(">Compliance<"));
  for (const name of ["Compliance", "Listing &amp; ads", "Portals + social"]) {
    assert.match(html, new RegExp(`disabled="" title="Classify it first: put it on Rent units or Sale units\\."[^>]*>${name.replace("+", "\\+")}<`));
  }
  assert.doesNotMatch(html, />Classify unit</);
  // A deal on CRM & commission is not offered the daily report, which takes no cards.
  const last = render(MoveMenu, { workflow: REAL_ESTATE_WORKFLOW, card: deal({ step: "D9" }), today: BOARD.today, onMove() {} });
  assert.doesNotMatch(last, /Daily AI report/);
});

test("a drop lands only where the rules allow it", () => {
  assert.equal(boardCanDrop(REAL_ESTATE_WORKFLOW, BOARD, "u1", "S5", "S6"), true);
  assert.equal(boardCanDrop(REAL_ESTATE_WORKFLOW, BOARD, "u1", "S5", "S2"), false);
  assert.equal(boardCanDrop(REAL_ESTATE_WORKFLOW, BOARD, "u1", "S5", "D4"), false);
  assert.equal(boardCanDrop(REAL_ESTATE_WORKFLOW, BOARD, "u1", "S5", "S9"), false);
  assert.equal(boardCanDrop(REAL_ESTATE_WORKFLOW, BOARD, "d1", "D5", "D8"), false);
  assert.equal(boardCanDrop(REAL_ESTATE_WORKFLOW, BOARD, "d1", "D5", "D7"), true);
  assert.equal(boardCanDrop(REAL_ESTATE_WORKFLOW, BOARD, "nope", "D5", "D7"), false);
});

test("the Workflow panel offers the live picture and the board; the board hides the period", () => {
  const picture = render(WorkflowPanel, { slug: "sfs-international" });
  assert.match(picture, /aria-label="View"/);
  assert.match(picture, /aria-pressed="true"[^>]*>Live picture</);
  assert.match(picture, />7 days</);
  const board = render(WorkflowPanel, { slug: "sfs-international", initialView: "board" });
  assert.match(board, /aria-pressed="true"[^>]*>Board</);
  assert.doesNotMatch(board, />7 days</);
  assert.match(board, /aria-label="Loading the board"/);
  const panel = read("app/deck/workflow/panel.tsx");
  assert.match(panel, /localStorage\.getItem\("nexus\.workflow\.view"\)/);
  assert.match(panel, /try \{[\s\S]{0,120}localStorage\.setItem\("nexus\.workflow\.view"/);
});

test("the board panel: a refused move says why, a lost race reloads, a late answer is dropped", () => {
  const src = read("app/deck/workflow/board/board-panel.tsx");
  assert.match(src, /role="status"/);
  assert.match(src, /\/\^API 409 \//);
  assert.match(src, /asked !== requestId\.current/);
  // Refresh keeps the cards on screen: nothing clears the board before the new one lands.
  assert.doesNotMatch(src, /setBoard\(null\)/);
  assert.match(src, /The board could not be loaded\./);
  assert.match(src, />\s*Try again\s*</);
});

test("the board's styles are its own, and its lanes scroll inside themselves", () => {
  const css = read("app/deck/workflow/workflow.css");
  assert.match(css, /\.wf-board-lane \{[^}]*overflow-x: auto/);
  assert.match(css, /\.wf-board-expired \{/);
  for (const file of ["app/kit/kit.css", "app/deck/hq/hq.css", "app/deck/deck.css"]) {
    assert.doesNotMatch(read(file), /\.wf-board/, file);
  }
});

// ---- Task 7: the card window and adding ------------------------------------------------------

const detail = (card, over = {}) =>
  render(CardDetail, {
    workflow: REAL_ESTATE_WORKFLOW,
    card,
    board: BOARD,
    history: [],
    now: NOW,
    timezone: "Asia/Dubai",
    origin: null,
    message: "",
    onSave: async () => {},
    onMove() {},
    onCloseCard() {},
    onLink() {},
    onUnlink() {},
    onDismiss() {},
    ...over,
  });

test("the card window: what the step needs, and its history in words", () => {
  const history = [
    { kind: "created", from: null, to: "D4", closedReason: null, by: "Aisha", at: ago(3) },
    { kind: "moved", from: "D4", to: "D7", closedReason: null, by: "Aisha", at: ago(1) },
    { kind: "moved", from: "D7", to: "D9", closedReason: null, by: null, at: ago(0) },
  ];
  const html = detail(deal({ id: "d7", step: "D7" }), { history });
  assert.match(html, /What this step needs/);
  assert.match(html, /class="wf-board-need wf-board-need-missing">Ejari number/);
  assert.match(html, /Created on Unit matcher by Aisha/);
  assert.match(html, /Moved to Rent deal by Aisha/);
  assert.match(html, /Moved to CRM &amp; commission by someone no longer here/);
  assert.match(html, /Move to…/);
  assert.match(detail(deal({ id: "d8" }), { history: null }), /Loading the history…/);
});

test("closing says which ways are open for this card", () => {
  const sale = detail(unit({ id: "u9", step: "S7", purpose: "sale" }));
  assert.match(sale, /disabled="" title="Only a unit to let can close as Let\."[^>]*>Let</);
  assert.doesNotMatch(sale, /disabled=""[^>]*>Sold</);
  assert.doesNotMatch(sale, /disabled=""[^>]*>Withdrawn</);
  const early = detail(deal({ step: "D5" }));
  assert.match(early, /disabled="" title="A deal closes as Won from Rent deal, Sale deal or CRM &amp; commission\."[^>]*>Won</);
  assert.doesNotMatch(early, /disabled=""[^>]*>Lost</);
});

test("an owner's name shows only to whoever may see that customer", () => {
  assert.match(detail(unit({ owner: { contactId: "c3", name: null } })), /Owner: with Aisha Khan/);
  assert.match(detail(unit({ owner: { contactId: "c3", name: "Owner B" } })), /Owner: Owner B/);
  assert.match(detail(unit({ owner: null })), /Owner: not recorded/);
});

test("a deal lists the units offered to it, and a unit the deals it was offered to", () => {
  const offered = detail(deal({ id: "d1", unitIds: ["u2"] }));
  assert.match(offered, /Units offered/);
  assert.match(offered, /JLT Cluster X · 805/);
  assert.match(offered, />Remove</);
  assert.match(offered, /<option value="u1">Marina Gate 2 · 1204<\/option>/);
  assert.doesNotMatch(offered, /<option value="u2">/);
  const board = { ...BOARD, deals: [deal({ id: "d1", contact: { id: "c1", name: "Lead one" } })] };
  assert.match(detail(unit({ id: "u2", dealIds: ["d1"] }), { board }), /Offered to[\s\S]*Lead one/);
});

test("adding a lead needs rent or buy before it can be saved, and starts on Unit matcher", () => {
  const html = render(AddCard, { kind: "deal", preset: null, contacts: [], message: "", onSearch() {}, onCreate: async () => {}, onDismiss() {} });
  assert.match(html, /<button type="submit"[^>]*disabled=""[^>]*>Put on the board</);
  assert.match(html, /<option value="D4" selected="">Unit matcher<\/option>/);
  assert.match(html, /<option value="D3">Cold lead<\/option>/);
  assert.match(html, /Renting/);
  assert.match(html, /Buying/);
  const preset = render(AddCard, { kind: "deal", preset: { contactId: "c9", name: "Hot lead" }, contacts: [], message: "", onSearch() {}, onCreate: async () => {}, onDismiss() {} });
  assert.match(preset, /Hot lead/);
  const unitForm = render(AddCard, { kind: "unit", preset: null, contacts: [], message: "", onSearch() {}, onCreate: async () => {}, onDismiss() {} });
  assert.match(unitForm, /<button type="submit"[^>]*disabled=""[^>]*>Add unit</);
});

test("money is typed the way people type it", () => {
  assert.equal(toAed("1,200,000"), 1200000);
  assert.equal(toAed(" 85 000 "), 85000);
  assert.equal(toAed("95000.50"), 95000.5);
  assert.equal(toAed(""), null);
  assert.equal(toAed("   "), null);
  assert.ok(Number.isNaN(toAed("85k")));
  assert.ok(Number.isNaN(toAed("-5")));
});

// ---- Found in the preview (3 Nov 2026) ----------------------------------------------------------

test("the page no longer says nothing is typed in: staff record units and deals on the board", () => {
  const page = read("app/deck/workflow/page.tsx");
  assert.doesNotMatch(page, /Nothing here is typed in/);
  assert.match(page, /the units and deals your team keeps on the Board/);
});

test("a card's words wrap instead of being cut off", () => {
  const css = read("app/deck/workflow/workflow.css");
  assert.match(css, /\.wf-board-card \.kit-card-title,\s*\.wf-board-card \.kit-card-sub \{[^}]*white-space: normal/);
});

test("a shut move or closing looks shut, not only unclickable", () => {
  const css = read("app/deck/workflow/workflow.css");
  assert.match(css, /\.wf-board-move \.kit-pill:disabled,\s*\.wf-board-detail \.kit-pill:disabled \{[^}]*opacity: \.45;[^}]*cursor: not-allowed/);
});

test("a lost race reads as where the card went, in the server's words (final review)", () => {
  const body = JSON.stringify({ error: "Someone moved this card to Viewing a moment ago." });
  assert.equal(readableError(new Error(`API 409 on /api/organizations/sfs-international/workflow-board/deals/d1/move: ${body}`)), "Someone moved this card to Viewing a moment ago.");
});

test("saving sends only what this person touched, never a colleague's change back (final review)", () => {
  const opened = unit({ id: "u5", step: "S8", purpose: "rent", permitExpiresOn: "2026-12-01" });
  const draft = { ...draftOf(opened), notes: "Keys with the concierge" };
  // A colleague moved the expiry while this window was open, and the board reloaded.
  const reloaded = { ...opened, permitExpiresOn: "2027-01-31" };
  assert.deepEqual(unsavedChanges(reloaded, draft, reloaded.liveOn, new Set(["notes"])), { changes: { notes: "Keys with the concierge" } });
  assert.deepEqual(unsavedChanges(reloaded, draft, reloaded.liveOn, new Set()), { changes: {} });
  // A field this person did change is theirs to save.
  const mine = { ...draft, permitExpiresOn: "2027-06-30" };
  assert.deepEqual(unsavedChanges(reloaded, mine, reloaded.liveOn, new Set(["permitExpiresOn"])), { changes: { permitExpiresOn: "2027-06-30" } });
  assert.deepEqual(unsavedChanges(reloaded, draft, ["bayut"], new Set(["liveOn"])), { changes: { liveOn: ["bayut"] } });
  assert.deepEqual(unsavedChanges(reloaded, { ...draft, priceAed: "85k" }, [], new Set(["priceAed"])), {
    problem: "Yearly rent or asking price, AED: Write the amount in dirhams, digits only — 1,200,000 is fine.",
  });
  const src = read("app/deck/workflow/board/card-detail.tsx");
  // What was touched is forgotten only once the save went through.
  assert.match(src, /if \(await onSave\([^)]*\)\) setTouched\(new Set\(\)\)/);
});
