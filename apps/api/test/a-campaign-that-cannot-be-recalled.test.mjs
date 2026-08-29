/**
 * The one action on this platform that cannot be undone.
 *
 * ============================================================
 * WHAT MAKES A STAFF CAMPAIGN DIFFERENT
 * ============================================================
 *
 * Everything else here can be corrected by doing it again differently. A bulk
 * send reaches real phones, at once, and stays reached.
 *
 * It is also the action with the most ways to be quietly wrong: the audience
 * can be somebody else's, the number it leaves from can be the company's when
 * the sender believes it is theirs, the ceiling can be applied by trimming, and
 * the message can be a template Meta approved for a different business on the
 * same shared account. Each of those produces a send that reports success.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const ROUTE = read("apps", "api", "src", "routes", "my-campaigns.ts");
const BOOK = read("packages", "db", "src", "client-book.ts");
const PAGE = read("apps", "web", "app", "deck", "my-campaigns", "page.tsx");
const INBOX = read("apps", "web", "app", "inbox", "page.tsx");
const prose = PAGE.replace(/\s+/g, " ");

// ============================================================
// The audience
// ============================================================

test("a staff campaign can only ever reach that person's own clients", () => {
  // Both predicates, in the function that resolves the audience. Either alone
  // returns a plausible, wrong list — and this is the list that gets messaged.
  const fn = BOOK.slice(BOOK.indexOf("export async function myClientsForBroadcast"));
  const sql = fn.slice(0, fn.indexOf("\n}"));
  assert.match(sql, /contactServedBy\("\$1"\)/, "not scoped to the business");
  assert.match(sql, /contactOwnedBy\("\$2"\)/, "not scoped to the person");
});

test("somebody who asked not to be messaged is not in the audience", () => {
  // A client book is where this is easiest to forget: these are people the
  // sender knows, so the sender feels entitled.
  const fn = BOOK.slice(BOOK.indexOf("export async function myClientsForBroadcast"));
  assert.match(fn.slice(0, fn.indexOf("\n}")), /reengagement_opted_out = false/);
});

test("the route resolves the audience itself and never takes one", () => {
  // An endpoint that accepts a recipient list is an endpoint for messaging
  // anybody. The audience is a property of who is asking, not of the request.
  assert.ok(!/body\.(recipients|contactIds|audience)/.test(ROUTE));
  assert.match(ROUTE, /myClientsForBroadcast\(desk\.organizationId, desk\.employeeId\)/);
});

// ============================================================
// The ceiling
// ============================================================

test("a campaign over the ceiling is refused whole, not trimmed", () => {
  // Trimming is the tempting version and the dangerous one: the people dropped
  // are invisible, so the sender believes the whole book was reached.
  assert.match(ROUTE, /audience\.length > allowance\.remaining/);
  assert.match(ROUTE, /429/);
  assert.match(prose.length ? ROUTE : ROUTE, /Nothing was sent/);
  assert.ok(
    !/\.slice\(0, allowance\.remaining\)/.test(ROUTE),
    "the audience is being trimmed to fit the ceiling"
  );
});

test("the ceiling is counted from recipients actually queued", () => {
  // Counted from intent, a cap is not a cap. The recipient rows are what cost
  // money and what move the shared number's quality rating.
  const fn = BOOK.slice(BOOK.indexOf("export async function broadcastAllowanceRemaining"));
  assert.match(fn, /from broadcast_recipients/);
  assert.match(fn, /date_trunc\('month', now\(\)\)/);
});

test("sending is a permission, not a default", () => {
  assert.match(ROUTE, /!employee\.canBroadcast/);
  assert.match(ROUTE, /403/);
});

// ============================================================
// The number it goes out from
// ============================================================

test("the number is stamped on the row and the job uses the stamp", () => {
  // Not recomputed from the employee at send time. If the two ever disagree it
  // is because somebody was reassigned mid-send, and the row records what was
  // committed to.
  assert.match(ROUTE, /from_phone_number_id|fromPhoneNumberId: from/);
  assert.match(ROUTE, /phoneNumberId: from/);
});

test("a number cannot be claimed unless Meta holds it", () => {
  // There is no endpoint for typing a number in. One stored without this check
  // produces a campaign that reports success to a whole book and reaches nobody.
  assert.match(ROUTE, /listWabaNumbers/);
  assert.match(ROUTE, /if \(!number\)/);
  assert.ok(
    !/body\.displayNumber|body\.waNumber/.test(ROUTE),
    "a number is being taken from the request instead of from Meta"
  );
});

test("the shared company number cannot be claimed by a person", () => {
  // Inbound routing keys on this column. One person owning the line every
  // business answers on would route every inbound message to them.
  assert.match(ROUTE, /organization\.whatsappPhoneNumberId/);
  assert.match(ROUTE, /belongs to the business, not to a person/);
});

test("two people cannot hold the same number", () => {
  const fn = BOOK.slice(BOOK.indexOf("export async function claimPhoneNumber"));
  assert.match(fn.slice(0, fn.indexOf("\n}\n")), /id <> \$2/);
});

// ============================================================
// The template, on a shared WhatsApp account
// ============================================================

test("a template approved for another business is refused", () => {
  // Meta approving a template says what it may send, never who it is for, and
  // a sync writes every template on the account under every business.
  assert.match(ROUTE, /attributeTemplate\(template\.metaTemplateName, organization\.slug\)/);
  assert.match(ROUTE, /other-business/);
  assert.match(ROUTE, /template\.organizationId !== organization\.id/);
});

// ============================================================
// The screen refuses to be a button
// ============================================================

test("the audience is shown by name before anything sends", () => {
  // A count is what somebody clicks past. A list of names is one they check.
  assert.match(prose, /This will message/);
  assert.match(PAGE, /audience\.map\(\(person\)/);
});

test("the send control names the count rather than saying Send", () => {
  assert.match(PAGE, /Message \$\{audience\.length\}/);
});

test("the screen says which number it will leave from", () => {
  assert.match(prose, /sending from/i);
  assert.match(prose, /Your clients see the company, not you/);
});

test("the screen says a phone's WhatsApp cannot be connected", () => {
  assert.match(prose, /has no way to be read by software/);
  // And says what CAN be done instead, which is the actionable half.
  assert.match(prose, /Meta Business Manager/);
});

// ============================================================
// The screenshot bug: a column of businesses nobody could open
// ============================================================

test("the inbox business list is scoped to the person, not hardcoded", () => {
  // It was built from a constant listing every business on the platform, so a
  // staff member assigned to one saw all five. The API refused four of them —
  // the scoping was never the problem — but a column of names somebody cannot
  // open teaches that the product is broken, and names four businesses they
  // have nothing to do with.
  assert.ok(
    !/BUSINESS_OPTIONS/.test(INBOX),
    "the inbox is listing every business from a constant again"
  );
  assert.match(INBOX, /useVisibleBusinesses/);
});

test("the inbox shows nothing until it knows who is asking", () => {
  // Rendering the full list and narrowing it a moment later shows every
  // business's name for exactly as long as it takes to read.
  assert.match(INBOX, /known\s*\?/);
});

test("a remembered business that is no longer visible is replaced", () => {
  // The selection is remembered across visits and defaulted to the first of the
  // old hardcoded list, so a staff member elsewhere landed on somebody else's
  // tab and got a 403 rendered as "could not load".
  assert.match(INBOX, /businesses\.some\(\(option\) => option\.slug === selectedOrg\)/);
  assert.match(INBOX, /setSelectedOrg\(businesses\[0\]\.slug\)/);
});

// ============================================================
// The owner removed our ceiling, and Meta's stayed
// ============================================================

test("a null cap is not a zero cap", () => {
  // Everyone's ceiling is null now. Coerced to 0 — the shape the code had while
  // the column was NOT NULL — every campaign would be refused and the screen
  // would read "0 of 0 left this month".
  assert.ok(
    !/broadcastMonthlyCap \?\? 0/.test(ROUTE),
    "a null ceiling is being read as zero, which blocks every send"
  );
  assert.match(ROUTE, /broadcastMonthlyCap \?\? null/);
});

test("the monthly refusal only fires where a ceiling was actually chosen", () => {
  assert.match(ROUTE, /allowance\.remaining !== null && audience\.length > allowance\.remaining/);
});

test("the real ceiling is reported, not enforced", () => {
  // The owner asked for no limitation and gets none from us. What they must not
  // get is a delivery report three days later revealing a third of the list was
  // never reached, so the number's own daily limit is stated instead.
  assert.match(ROUTE, /describeDailyCeiling/);
  assert.match(ROUTE, /sending anyway, per policy/);
  const send = ROUTE.slice(ROUTE.indexOf("const overDailyCeiling"));
  assert.ok(
    !/return c\.json\([\s\S]{0,200}429/.test(send.slice(0, 900)),
    "the daily ceiling is refusing the campaign, which is not ours to refuse"
  );
});

test("the daily count is cross-tenant, because the ceiling belongs to the number", () => {
  // Scoped to one business this returns a fraction of the true figure and reads
  // as plenty of headroom.
  const BOOK = read("packages", "db", "src", "client-book.ts");
  const fn = BOOK.slice(BOOK.indexOf("export async function dailyReachUsed"));
  assert.match(fn, /withAllTenants/);
  assert.match(fn, /count\(distinct r\.contact_id\)/);
});

test("the screen states the ceiling before the send, not only after", () => {
  // Somebody deciding whether to message four hundred people should see it
  // while they are deciding.
  const PAGE = read("apps", "web", "app", "deck", "my-campaigns", "page.tsx");
  assert.match(PAGE, /view\.dailyCeiling \? \(/);
  assert.match(PAGE, /new\s+conversations a day/);
  // And again at the point of no return.
  //
  // Anchored on the confirmation block's own class rather than on a phrase.
  // The first draft searched for "cannot be recalled", which appears in this
  // file's opening comment forty lines above the markup — so the slice began in
  // prose about the screen instead of in the screen.
  const confirm = PAGE.slice(PAGE.indexOf('className="cmp-confirm"'));
  assert.match(confirm, /will arrive/);
});

test("the used figure is described as a floor", () => {
  // Counted from our own queued recipients, so a template sent outside a
  // campaign is not in it. A precise-looking number that is quietly low is
  // worse than an honest approximation.
  const PAGE = read("apps", "web", "app", "deck", "my-campaigns", "page.tsx");
  assert.match(PAGE, /at least/);
});
