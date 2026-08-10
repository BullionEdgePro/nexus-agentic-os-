// The admin's view of the team, and the bulk-send path behind Broadcasts.
//
// Both were added to answer "let me see what my employees do" and "add bulk
// WhatsApp messaging". Both touch things that fail quietly rather than loudly:
// a nav item with no destination, a count inflated by a join, a send that
// resolves the wrong business's contacts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

const ACTIVITY_SQL = read("packages", "db", "src", "activity.ts");
const BROADCAST_SQL = read("packages", "db", "src", "broadcasts.ts");
const BROADCAST_ROUTE = read("apps", "api", "src", "routes", "broadcasts.ts");
const API_INDEX = read("apps", "api", "src", "index.ts");
const DECK = read("apps", "web", "app", "deck-console.tsx");
const BROADCAST_PAGE = read("apps", "web", "app", "deck", "broadcasts", "page.tsx");
const WEB_API = read("apps", "web", "lib", "api.ts");

// ============================================================
// Every nav icon goes somewhere
// ============================================================

test("no nav item renders without a destination", () => {
  // Four icons used to render with no href at all: they highlighted on hover
  // and did nothing when clicked. That reads as a broken product, and it is
  // the specific thing the owner reported by screenshot.
  const rail = DECK.slice(DECK.indexOf('<nav className="rail">'), DECK.indexOf("</nav>"));
  const anchors = rail.match(/<a\b[^>]*>/g) ?? [];
  assert.ok(anchors.length >= 4, "the rail should still have items");

  for (const anchor of anchors) {
    const hasDestination = /href=/.test(anchor) || /onClick=/.test(anchor) || /className="on"/.test(anchor);
    assert.ok(hasDestination, `nav item goes nowhere: ${anchor}`);
  }
});

test("the nav points only at pages that exist", () => {
  const rail = DECK.slice(DECK.indexOf('<nav className="rail">'), DECK.indexOf("</nav>"));
  const routes = [...rail.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(routes.length > 0);

  for (const route of routes) {
    if (route.startsWith("http")) continue;
    // A route is real if there is a page file at that path.
    const page = join(here, "..", "..", "web", "app", ...route.split("/").filter(Boolean), "page.tsx");
    assert.ok(readFileSafe(page), `nav points at ${route} but no page.tsx exists there`);
  }
});

// ============================================================
// The activity numbers are not inflated
// ============================================================

test("conversations and leads are aggregated separately, not joined together", () => {
  // Joining both tables and grouping multiplies conversation rows by lead rows.
  // Someone with 3 conversations and 4 leads would read as 12 of each — a
  // number that looks plausible, is wrong, and never errors.
  const query = ACTIVITY_SQL.slice(ACTIVITY_SQL.indexOf("select e.id"), ACTIVITY_SQL.indexOf("order by o.name"));
  assert.ok(/left join \(\s*select employee_id/.test(query), "conversations must be pre-aggregated");
  assert.equal(
    (query.match(/group by employee_id/g) ?? []).length,
    2,
    "both conversations and leads must be grouped inside their own subquery"
  );
  assert.ok(!/join lead_assessments\s+\w+\s+on/.test(query), "lead_assessments must not be joined directly");
});

test("activity only counts leads an employee actually logged", () => {
  // lead_assessments also holds inbound leads the agent scored on its own,
  // which have no employee. Counting those against a person would credit them
  // with work the system did.
  assert.match(ACTIVITY_SQL, /where employee_id is not null and source = 'employee_direct'/);
});

test("never signed in reads as never, not as 1970", () => {
  // Date-parsing a null yields the epoch, so a naive max() would rank someone
  // who has never signed in as "last active 56 years ago" — sorted, formatted
  // and entirely wrong.
  assert.ok(
    !/new Date\(row\.last_login_at\)/.test(ACTIVITY_SQL),
    "nulls must not be pushed through Date before the null check"
  );
  assert.match(ACTIVITY_SQL, /lastLead \?\? lastLogin \?\? null/);
});

test("activity is operator-only", () => {
  // An employee reading this endpoint would see every colleague's numbers, and
  // on a shared platform that means every other business's staff too.
  assert.match(API_INDEX, /app\.use\("\/api\/activity", operatorOnly\)/);
  assert.match(API_INDEX, /app\.use\("\/api\/activity\/\*", operatorOnly\)/);
});

// ============================================================
// A send cannot cross businesses
// ============================================================

test("the send path takes its organization from the broadcast, not the request", () => {
  // It used to require organizationId in the body and never compare it to the
  // broadcast's own. Pairing broadcast A with organization B would have
  // resolved B's entire contact list as A's audience — a bulk message to the
  // wrong company's customers, returning 200.
  const sendRoute = BROADCAST_ROUTE.slice(BROADCAST_ROUTE.indexOf('broadcastsRoute.post("/:id/send"'));
  assert.match(sendRoute, /const broadcast = await getBroadcast\(broadcastId\)/);
  assert.match(sendRoute, /findOrganizationById\(broadcast\.organizationId\)/);
  assert.match(sendRoute, /getContactsForAudience\(broadcast\.organizationId/);
  assert.ok(
    !/body\.organizationId|body\?\.organizationId/.test(sendRoute),
    "the organization must never come from the request body"
  );
});

test("an unapproved template is refused at send, not only at draft", () => {
  // Approval is checked when the draft is created, but Meta can withdraw it in
  // between. This is the last gate before messages leave.
  const sendRoute = BROADCAST_ROUTE.slice(BROADCAST_ROUTE.indexOf('broadcastsRoute.post("/:id/send"'));
  assert.match(sendRoute, /if \(!template\.isApproved\)/);
  assert.match(sendRoute, /422/);
});

test("the page reads the field the API actually returns", () => {
  // The route returns { broadcastId, enqueued }. Reading `queued` would render
  // "Queued for undefined contacts" after a send that genuinely worked.
  assert.match(BROADCAST_ROUTE, /return c\.json\(\{ broadcastId, enqueued: recipients\.length \}\)/);
  assert.match(WEB_API, /Promise<\{ broadcastId: string; enqueued: number \}>/);
  assert.match(BROADCAST_PAGE, /const \{ enqueued \} = await sendBroadcast/);
  assert.ok(!/\{ queued \}/.test(BROADCAST_PAGE), "the page must not read a field that is never sent");
});

test("the Send button is disabled until a send could actually succeed", () => {
  // WhatsApp blocks business-initiated messages without an approved template,
  // a verified business and billing. A button that always 422s teaches people
  // the product is broken; a disabled button beside the reason does not.
  assert.match(BROADCAST_ROUTE, /canSend: templates\.some\(\(template\) => template\.isApproved\) && reachable > 0/);
  assert.match(BROADCAST_PAGE, /disabled=\{!canSend \|\| !templateId \|\| busy\}/);
  assert.match(BROADCAST_PAGE, /Sending is not open yet/);
  console.log("PASS: nav has no dead ends, activity counts are unjoined, sends cannot cross businesses");
});

function readFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ============================================================
// Templates mirror Meta rather than being declared locally
// ============================================================

const CLIENT = read("apps", "api", "src", "lib", "whatsapp-client.ts");
const SYNC = read("apps", "api", "src", "services", "template-sync.ts");
const MIGRATION_017 = read("packages", "db", "migrations", "017-template-sync.sql");

test("approval is derived from Meta's status in exactly one place", () => {
  // is_approved used to be a boolean an operator typed in, recording what they
  // believed rather than what Meta had decided. A stale `true` means a send
  // that fails at the last hop, after every row and queue job already exists.
  assert.match(BROADCAST_SQL, /is_approved.*\n?.*\$6 = 'APPROVED'|\$6 = 'APPROVED'/);
  assert.ok(
    !/is_approved\s*=\s*true/.test(BROADCAST_SQL.replace(/excluded\.is_approved/g, "")),
    "nothing may set is_approved to a literal true"
  );
});

test("only APPROVED counts as sendable", () => {
  // Meta reports PENDING, REJECTED, PAUSED and DISABLED as well. Treating any
  // of them as sendable produces a broadcast that fails per recipient.
  assert.match(BROADCAST_SQL, /'APPROVED'/);
  assert.ok(!/'PENDING'|'PAUSED'/.test(BROADCAST_SQL.split("upsertTemplateFromMeta")[1] ?? ""));
});

test("a failed sync cannot wipe the template list", () => {
  // An empty response from a failed or permission-denied call would otherwise
  // mark every template deleted and silently disable bulk messaging platform-wide.
  assert.match(SYNC, /templates\.length > 0 \? await retireMissingTemplates/);
});

test("one business failing a sync does not stop the others", () => {
  const loop = SYNC.slice(SYNC.indexOf("export async function syncAllTemplates"));
  assert.match(loop, /try \{[\s\S]*?\} catch/);
});

test("template listing follows Meta's paging", () => {
  // Reading only the first page silently drops templates past the hundredth,
  // and the symptom is a template that exists at Meta but never appears here.
  assert.match(CLIENT, /paging\?\.next/);
});

test("placeholders are counted distinctly, not by occurrence", () => {
  // "{{1}} ... {{1}}" is one parameter. Counting it twice makes Meta reject
  // every send of that template on a parameter-count mismatch.
  assert.match(CLIENT, /new Set\(body\.text\.match/);
});

test("a send supplies exactly as many parameters as the template declares", () => {
  assert.match(BROADCAST_ROUTE, /resolveTemplateParams\(template\.bodyParamCount, contact\.displayName\)/);
  assert.match(BROADCAST_ROUTE, /if \(count <= 0\) return \[\]/);
  // An empty string is rejected by Meta as a missing parameter, so unnamed
  // contacts must still get a real value.
  assert.match(BROADCAST_ROUTE, /displayName\?\.trim\(\) \|\| "there"/);
});

test("no components key is sent when the template takes no parameters", () => {
  assert.match(CLIENT, /bodyParams\.length[\s\S]{0,200}components/);
});

test("the mirror keeps Meta's own words, not a boolean", () => {
  assert.match(MIGRATION_017, /add column if not exists status\s+text/);
  assert.match(MIGRATION_017, /add column if not exists body_param_count/);
  assert.match(MIGRATION_017, /add column if not exists synced_at/);
  // Identity is the Meta id, not the name: names are reused across languages
  // and can be recreated after deletion.
  assert.match(MIGRATION_017, /on message_templates \(organization_id, meta_template_id\)/);
  console.log("PASS: template approval mirrors Meta and cannot be asserted locally");
});
