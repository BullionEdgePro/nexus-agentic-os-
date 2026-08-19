// A campaign goes out from Juris Prime. A recipient replies "yes please".
//
// That reply arrives on the shared number carrying no #tag and probably no
// keyword, so every routing rule fails to place it — and the customer is shown
// a menu of five firms by the same number that messaged them ninety seconds
// earlier. Then, if they answer the menu wrong three times, the conversation is
// handed to a human as unplaceable.
//
// Nobody decided that. It is what "route by the text of the message" does when
// the message is a reply to something, and the context that answers it was
// already in the database: broadcast_recipients knows who was messaged, and
// broadcasts knows which business sent it.
//
// Zero campaigns have been sent, so this fixes a trap rather than an incident —
// the machinery is complete and unusable in practice without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const BROADCASTS = read("packages", "db", "src", "broadcasts.ts");
const ROUTER = read("packages", "agents", "src", "business-router.ts");

/** The routing decision, bounded so an assertion cannot match a neighbour. */
function routingBlock() {
  const start = PROCESSOR.indexOf("const outcome = classifyBusiness(");
  assert.ok(start > -1, "the routing decision moved");
  return PROCESSOR.slice(start, PROCESSOR.indexOf("await askWhichBusiness(", start));
}

test("the classifier stays a pure function of the text", () => {
  // The database lookup deliberately does NOT go inside classifyBusiness. It is
  // pure so it can be unit-tested against invented businesses and run against
  // the real registry by deep-link-check without touching a connection.
  assert.ok(
    !/getPool|await |async /.test(ROUTER.slice(ROUTER.indexOf("export function classifyBusiness"))),
    "classifyBusiness must not reach for the database"
  );
});

test("who messaged them is consulted only after what they said", () => {
  const block = routingBlock();
  const routed = block.indexOf('outcome.kind === "routed"');
  const broadcast = block.indexOf("findRecentBroadcastSender");
  assert.ok(routed > -1 && broadcast > -1, "both branches must exist");
  assert.ok(
    routed < broadcast,
    "an explicit tag or keyword is something the customer said — it must win"
  );
});

test("and before the triage counter, so a reply costs nobody a chance", () => {
  const block = routingBlock();
  const broadcast = block.indexOf("findRecentBroadcastSender");
  const attempts = block.indexOf("MAX_TRIAGE_ATTEMPTS");
  assert.ok(attempts > -1, "the triage attempt guard moved");
  assert.ok(
    broadcast < attempts,
    "routing a campaign reply must not burn one of three chances to be understood"
  );
});

test("only a business actually on this number can be routed to", () => {
  // The sender is looked up in `businesses` — the ones answering on this
  // number — rather than trusted from the broadcast row. A campaign from a
  // business that has since been deactivated or moved off the number must not
  // route anybody.
  assert.match(routingBlock(), /businesses\.find\(\(business\) => business\.id === priorContact\.organizationId\)/);
});

test("the lookup is cross-tenant and says why", () => {
  const fn = BROADCASTS.slice(BROADCASTS.indexOf("export async function findRecentBroadcastSender"));
  // `broadcasts` is tenant-scoped and the reply path runs as the number's
  // OWNER, so a Juris Prime campaign is invisible there. This is the eighth
  // appearance of that trap and the first where widening to the serving
  // business cannot be the fix — which business is serving is the question.
  assert.match(fn, /withAllTenants\("switchboard: which business messaged this contact"/);
  assert.match(BROADCASTS, /it is what determines the tenant/);
});

test("a recipient who was never actually messaged routes nobody", () => {
  const fn = BROADCASTS.slice(BROADCASTS.indexOf("export async function findRecentBroadcastSender"));
  // `pending` means the row exists and the send has not happened. Routing on it
  // would place a customer with a business that has not spoken to them.
  assert.match(fn, /r\.status in \('sent', 'delivered'\)/);
  assert.match(fn, /r\.sent_at is not null/);
  assert.match(fn, /order by r\.sent_at desc/);
});

test("the window is a judgement and is labelled as one", () => {
  // No campaign has ever been sent, so there is no reply-latency distribution
  // to fit to. Saying so is the difference between a chosen number and one that
  // looks measured.
  assert.match(PROCESSOR, /const BROADCAST_ROUTING_WINDOW_HOURS = 24 \* 7;/);
  assert.match(PROCESSOR, /a judgement rather than a measurement/);
  assert.match(PROCESSOR, /Revisit it against real reply times/);
});

test("a failed lookup falls through to asking, never to an error", () => {
  // The triage menu is a worse answer, not a broken one. A database hiccup here
  // must degrade to the behaviour the platform had yesterday.
  assert.match(routingBlock(), /\.catch\(\(\) => null\)/);
});
