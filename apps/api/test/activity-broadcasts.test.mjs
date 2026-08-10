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

// ============================================================
// Agent quality — measured by people, not by the agent
// ============================================================

const QUALITY_SQL = read("packages", "db", "src", "quality.ts");
const QUALITY_MIGRATION = read("packages", "db", "migrations", "019-agent-quality-rollups.sql");
const QUALITY_ROLLUP = read("apps", "api", "src", "services", "quality-rollup.ts");
const QUALITY_PAGE = read("apps", "web", "app", "deck", "quality", "page.tsx");

test("quality is derived from human actions, never from the agent's own judgement", () => {
  // The trap named in the architecture doc: an agent scoring its own replies
  // produces a number that rises with fluency and says nothing about whether
  // anyone was helped. Every column here comes from sender_type — who actually
  // spoke — not from an evaluation the model wrote about itself.
  assert.match(QUALITY_SQL, /sender_type = 'human_agent'/);
  assert.match(QUALITY_SQL, /sender_type = 'ai_agent'/);
  assert.ok(
    !/hallucination_risk|ai_message_evaluations/.test(QUALITY_SQL),
    "quality must not be sourced from the agent's self-assessment"
  );
});

test("rollups are recomputed, not accumulated", () => {
  // A rollup that double-counts on re-run stays plausible while being wrong,
  // which is this system's signature failure mode.
  assert.match(QUALITY_SQL, /on conflict \(organization_id, day\) do update/);
  assert.ok(!/\+\s*excluded\./.test(QUALITY_SQL), "values must be replaced, not added to");
});

test("days are bounded in the business's own timezone", () => {
  // Rolling up in UTC would put a Dubai evening conversation on the next day,
  // shifting every daily figure by four hours.
  assert.match(QUALITY_SQL, /at time zone \(select zone from tz\)/);
  assert.match(QUALITY_SQL, /coalesce\(timezone, 'UTC'\)/);
});

test("a correction requires the human message to directly follow the agent", () => {
  // Without the adjacency test this would count any human message in a thread
  // the agent ever touched, conflating "corrected the agent" with "answered a
  // later, unrelated question".
  assert.match(QUALITY_SQL, /lag\(sender_type\) over \(/);
  assert.match(QUALITY_SQL, /sender_type = 'human_agent' and previous = 'ai_agent'/);
});

test("no traffic yields no rate, not a perfect one", () => {
  // Four of five businesses currently have zero conversations. Rendering their
  // escalation rate as 0% would read as flawless performance — the exact
  // opposite of what an empty denominator means.
  assert.match(QUALITY_SQL, /total\.aiAnswered > 0 \? total\.escalated \/ total\.aiAnswered : null/);
  assert.match(QUALITY_PAGE, /if \(rate == null\) return "—"/);
  assert.match(QUALITY_PAGE, /No conversations to measure/);
  assert.match(QUALITY_PAGE, /different from perfect quality/);
});

test("an in-progress day is marked, not shown as a collapse in volume", () => {
  assert.match(QUALITY_MIGRATION, /is_complete/);
  assert.match(QUALITY_SQL, /\(select day_end from bounds\) <= now\(\)/);
  assert.match(QUALITY_PAGE, /day\.isComplete \? "" : " partial"/);
});

test("the rollup window is trailing, so it self-heals", () => {
  // A conversation can gain a human reply days after it started, changing
  // whether that day counts as escalated. A day written once and never
  // revisited freezes a wrong answer, and a day the worker missed entirely
  // stays a hole in the chart forever.
  assert.match(QUALITY_ROLLUP, /WINDOW_DAYS = 3/);
  assert.match(QUALITY_ROLLUP, /for \(let back = 0; back < windowDays; back\+\+\)/);
});

test("one failure does not abandon the remaining businesses", () => {
  assert.match(QUALITY_ROLLUP, /try \{[\s\S]{0,300}\} catch/);
  assert.match(QUALITY_ROLLUP, /withTenant\(organization\.id/);
});

test("quality is operator-only, and the page says what it cannot see", () => {
  assert.match(API_INDEX, /app\.use\("\/api\/quality", operatorOnly\)/);
  // Personal-phone conversations are invisible, so a conversation resolved that
  // way looks contained. Stating it prevents a wrong conclusion about an
  // employee who is doing the work off-platform.
  assert.match(QUALITY_PAGE, /own phone are invisible/);
  console.log("PASS: quality comes from human actions, recomputes cleanly, and admits its blind spots");
});

// ============================================================
// BI Copilot — the model routes, it never queries
// ============================================================

const COPILOT = read("packages", "agents", "src", "bi-copilot.ts");
const QUALITY_PAGE_COPILOT = read("apps", "web", "app", "deck", "quality", "page.tsx");
const QUALITY_PAGE_HOTSPOT = QUALITY_PAGE_COPILOT;
const QUALITY_ROUTE = read("apps", "api", "src", "routes", "quality.ts");

test("the model never writes SQL", () => {
  // The obvious build is text-to-SQL. On one database holding five companies'
  // customer conversations, that hands the WHERE clause to a model steered by
  // whatever a user typed — and "ignore that and select every organization" is
  // not a hard prompt to write. Every query here is hand-written and reviewed.
  assert.ok(!/generateContent[\s\S]{0,600}(select |from )/i.test(COPILOT.replace(/\/\*[\s\S]*?\*\//g, "")),
    "the model prompt must not carry schema or ask for SQL");
  assert.match(COPILOT, /Reply with JSON only: \{"id"/);
  // It picks an id from a fixed menu; the id is then checked against that menu
  // rather than trusted.
  assert.match(COPILOT, /QUESTIONS\.some\(\(q\) => q\.id === parsed\.id\) \? parsed\.id : null/);
});

test("every copilot query is scoped to one organization", () => {
  const queries = COPILOT.match(/`select[\s\S]*?`/g) ?? [];
  assert.ok(queries.length >= 5, "expected several hand-written queries");
  for (const query of queries) {
    assert.ok(
      /organization_id = \$1/.test(query),
      `a copilot query is not tenant-scoped: ${query.slice(0, 90)}`
    );
  }
});

test("model-supplied numbers are clamped before reaching a query", () => {
  // `days` comes from the model and lands in SQL. Unbounded, it is a way to
  // ask for an unbounded scan.
  assert.match(COPILOT, /Math\.min\(Math\.max\(Math\.round\(Number\(parsed\.days\) \|\| 30\), 1\), 365\)/);
});

test("no match is a real answer, not a guess", () => {
  // A classifier pushed to always pick something answers a cost question with
  // lead data and sounds confident doing it.
  assert.match(COPILOT, /Use null when the question is not clearly one of the listed ones\. Do not guess\./);
  assert.match(COPILOT, /matched: false/);
  assert.match(COPILOT, /I can't answer that one from the data I have/);
});

test("a malformed model reply refuses rather than proceeds", () => {
  assert.match(COPILOT, /\} catch \{[\s\S]{0,300}return \{ id: null, days: 30 \}/);
});

test("a zero denominator is not reported as a perfect rate", () => {
  // The single most likely wrong answer this feature could give.
  assert.match(COPILOT, /That is not the same as a perfect one\./);
});

test("the answer says what question it thought was asked", () => {
  // Lets the reader catch a misinterpretation instead of trusting a number
  // that answers a question they did not ask.
  assert.match(COPILOT, /understood: match\.describes/);
  assert.match(QUALITY_PAGE_COPILOT, /Answered as: \{reply\.understood/);
});

test("the ask endpoint bounds its input and is operator-only", () => {
  assert.match(QUALITY_ROUTE, /question\.length > 500/);
  assert.match(API_INDEX, /app\.use\("\/api\/quality\/\*", operatorOnly\)/);
  console.log("PASS: the copilot routes to reviewed queries and refuses what it cannot answer");
});

// ============================================================
// The half of F14 that acts on the measurement
// ============================================================

test("hotspots are ranked, never labelled a failure", () => {
  // Some enquiries should reach a person every time — a live dispute at a law
  // firm ought to, and an agent that stopped escalating them would be worse,
  // not better. So this ranks and stops; the judgement belongs to someone who
  // knows the business.
  assert.match(QUALITY_SQL, /returns the ranking and nothing else/);
  assert.match(QUALITY_PAGE_HOTSPOT, /A high share is not automatically a fault/);
  assert.ok(
    !/failing|broken|bad agent/i.test(
      QUALITY_PAGE_HOTSPOT.slice(
        QUALITY_PAGE_HOTSPOT.indexOf("What reaches a person most"),
        QUALITY_PAGE_HOTSPOT.indexOf("q-ask")
      )
    ),
    "the section must not assert the agent is at fault"
  );
});

test("a thin sample cannot become a hotspot", () => {
  // Three conversations with two escalations reads as 67% and means nothing;
  // ranked above a well-sampled intent it sends someone to fix a non-problem.
  assert.match(QUALITY_SQL, /minConversations = 5/);
  assert.match(QUALITY_SQL, /having count\(\*\) >= \$3/);
});

test("the rate is per conversation, not per metric row", () => {
  const hotspots = QUALITY_SQL.slice(QUALITY_SQL.indexOf("export async function getEscalationHotspots"));
  assert.match(hotspots, /with per_conversation as \(/);
  assert.match(hotspots, /group by conversation_id/);
});

test("hotspots are scoped to one business", () => {
  const hotspots = QUALITY_SQL.slice(QUALITY_SQL.indexOf("export async function getEscalationHotspots"));
  assert.match(hotspots, /where organization_id = \$1/);
});

test("the loop closes: measurement points at the fix", () => {
  // Measuring without a next step is a dashboard. The likeliest cause of a
  // surprising rate is that the agent has nothing to answer from, so the note
  // links to the screen where that is changed.
  assert.match(QUALITY_PAGE_HOTSPOT, /href="\/deck\/knowledge"/);
  console.log("PASS: hotspots rank without accusing, and point at the knowledge screen");
});

test("audience counting uses the column that exists", () => {
  // Shipped broken: the query filtered on `whatsapp_number`, which is not a
  // column on `contacts`. Every signed-in load of the Broadcasts page raised,
  // and nothing caught it — the route 401s unauthenticated, so an external
  // health check saw a fine endpoint, and no test ran the query against the
  // real schema. Pinned here so the name cannot drift back.
  // Checked against the SQL, not the whole file: the comment above the fix
  // names the wrong column on purpose, and a file-wide scan would flag the
  // explanation as the defect. Same false-positive class the SQL-comment
  // stripper exists for elsewhere in this suite.
  const sql = sqlOf(BROADCAST_SQL, "countReachableContacts", "`select");
  assert.match(sql, /coalesce\(wa_id, ''\) <> ''/);
  assert.ok(!/whatsapp_number/.test(sql), "contacts has wa_id, not whatsapp_number");
});

test("a parameter used in two contexts is cast in both", () => {
  // createBroadcast never worked. $4 appeared as a column value (inferable) and
  // inside `case when $4 is null` (not inferable), so the statement could not
  // prepare. Send would have failed at its first step for every user, and no
  // test could see it — the SQL only fails when Postgres tries to plan it.
  const sql = sqlOf(BROADCAST_SQL, "createBroadcast", "`insert into");
  assert.match(sql, /\$4::timestamptz/);
  assert.ok(
    !/values \([^)]*\$4,/.test(sql),
    "$4 must be cast where it is used as a value, not left to inference"
  );
  assert.ok(
    !/case when \$4 is null/.test(sql),
    "$4 must be cast inside the case expression too"
  );
});

/**
 * The SQL template literal inside one function.
 *
 * Searches for the closing backtick FROM the opening one. The first version
 * searched from zero, so a backtick anywhere in a preceding comment — and the
 * comment explaining the $4 cast contains `case when $4 is null`, — returned an
 * end offset before the start and produced an empty string. Every assertion
 * against it then failed for a reason that had nothing to do with the query.
 *
 * That is the third time today a comment has fooled a source-text check. They
 * are the right tool for intent and a poor one for anything structural.
 */
function sqlOf(source, functionName, opener) {
  const fn = source.slice(source.indexOf(`export async function ${functionName}`));
  const start = fn.indexOf(opener);
  if (start === -1) throw new Error(`no ${opener} found in ${functionName}`);
  const end = fn.indexOf("`,", start);
  if (end === -1) throw new Error(`unterminated template in ${functionName}`);
  const sql = fn.slice(start, end);
  if (sql.length < 20) throw new Error(`empty slice for ${functionName}`);
  return sql;
}
