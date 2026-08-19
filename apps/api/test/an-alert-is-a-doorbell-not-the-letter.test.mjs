// Findings were detected correctly and reached nobody.
//
// Sixteen operators sweep every ten minutes and are good at their job. Nothing
// ever told anyone what they found — the findings sit on a page, and a page has
// to be opened. Measured from the findings already in the table:
//
//   broken-knowledge   stood 4.7 hours on average, 28 times
//   customer-waiting   stood 10 hours on average
//
// And the two that were not averages: a quota failure took 53 of ABR's 72
// knowledge passages offline and the finding stood SIXTEEN HOURS; a customer
// picked a business from the triage menu, got nothing, and waited SEVENTEEN.
// Both were detected within ten minutes. Neither reached a person.
//
// THE HARD PART IS NOT DELIVERY, IT IS RESTRAINT. A finding's title names the
// customer — "Ahmed has been waiting 3 hours" — because that is what makes it
// useful on the deck. The destination here is a URL somebody pasted into a
// config file: Slack, a relay, a service nobody here has audited. So the alert
// carries the shape of the problem and a link, and the customer stays behind
// the platform's own sign-in.
//
// These are runtime assertions rather than a reading of the source, because
// "the payload does not contain a customer's name" is a claim about what goes
// over the wire.
import { test } from "node:test";
import assert from "node:assert/strict";

const WEBHOOK = "https://example.invalid/hook";

/** Captures what would have been posted, and never touches the network. */
function captureFetch() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  return calls;
}

/**
 * Findings as the sweep reports them — note there is no title to leak, by
 * construction: `RaisedFinding` does not carry one.
 */
const RAISED = [
  { organizationId: "org-zipicka", servingOrganizationId: "org-juris", operator: "customer-waiting", severity: "urgent" },
  { organizationId: "org-zipicka", servingOrganizationId: "org-juris", operator: "customer-waiting", severity: "urgent" },
  { organizationId: "org-abr", servingOrganizationId: null, operator: "broken-knowledge", severity: "warn" },
];

const SLUGS = { "org-zipicka": "zipicka", "org-juris": "juris-prime", "org-abr": "abr" };
const slugOf = (id) => SLUGS[id] ?? id;

async function dispatcher() {
  return import("../src/services/alert-dispatch.ts");
}

test("nothing is sent when no destination is configured", async () => {
  delete process.env.OPERATOR_ALERT_WEBHOOK_URL;
  const calls = captureFetch();
  const { dispatchRaisedFindings } = await dispatcher();
  await dispatchRaisedFindings(RAISED, slugOf);
  assert.equal(calls.length, 0, "an unconfigured platform must behave exactly as it did before");
});

test("the payload carries no customer and no finding text", async () => {
  process.env.OPERATOR_ALERT_WEBHOOK_URL = WEBHOOK;
  process.env.WEB_ORIGIN = "https://app.nexusagenticos.com";
  const calls = captureFetch();
  const { dispatchRaisedFindings } = await dispatcher();

  // Deliberately hostile input: a finding shaped like the real ones, carrying
  // fields a future edit might start passing through.
  const withPii = RAISED.map((f) => ({
    ...f,
    title: "Ahmed Al-Rashid has been waiting 3 hours",
    detail: "Their last message was about a tenancy dispute",
    subjectId: "contact-971554805419",
  }));

  await dispatchRaisedFindings(withPii, slugOf);
  assert.equal(calls.length, 1, "one message for the whole sweep");

  const serialised = JSON.stringify(calls[0].body);
  for (const leak of ["Ahmed", "Al-Rashid", "tenancy", "971554805419", "contact-"]) {
    assert.ok(!serialised.includes(leak), `the payload leaked ${JSON.stringify(leak)}: ${serialised}`);
  }
});

test("it says which business, which operator, and how severe", async () => {
  process.env.OPERATOR_ALERT_WEBHOOK_URL = WEBHOOK;
  const calls = captureFetch();
  const { dispatchRaisedFindings } = await dispatcher();
  await dispatchRaisedFindings(RAISED, slugOf);

  const text = calls[0].body.text;
  // The SERVING business, not the number's owner. An alert sent to the wrong
  // firm is worse than none — it teaches them to ignore the next one.
  assert.match(text, /juris-prime/);
  assert.ok(!text.includes("zipicka"), "the number's owner did not have this problem");
  assert.match(text, /URGENT/);
  assert.match(text, /customer-waiting/);
  // Two findings of the same shape are one line, with a count.
  assert.match(text, /customer-waiting \(2\)/);
  assert.match(calls[0].body.deck, /\/deck\/operators$/);
});

test("a warning does not buzz a phone unless asked to", async () => {
  process.env.OPERATOR_ALERT_WEBHOOK_URL = WEBHOOK;
  delete process.env.ALERT_ON_WARN;
  const calls = captureFetch();
  const { dispatchRaisedFindings } = await dispatcher();
  await dispatchRaisedFindings(RAISED, slugOf);
  assert.ok(!calls[0].body.text.includes("broken-knowledge"), "warn is not urgent");

  process.env.ALERT_ON_WARN = "true";
  const widened = captureFetch();
  await dispatchRaisedFindings(RAISED, slugOf);
  assert.match(widened[0].body.text, /broken-knowledge/);
  delete process.env.ALERT_ON_WARN;
});

test("nothing is sent when nothing became true", async () => {
  // The whole point of dispatching on the transition. `standing` is the same
  // number on the sweep a problem appears and the two hundred after it — an
  // alert keyed on that says the same thing every ten minutes until somebody
  // mutes the channel, which ends with it muted on the night it matters.
  process.env.OPERATOR_ALERT_WEBHOOK_URL = WEBHOOK;
  const calls = captureFetch();
  const { dispatchRaisedFindings } = await dispatcher();
  await dispatchRaisedFindings([], slugOf);
  assert.equal(calls.length, 0);
});

test("a dead webhook does not take the sweep down with it", async () => {
  process.env.OPERATOR_ALERT_WEBHOOK_URL = WEBHOOK;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const { dispatchRaisedFindings } = await dispatcher();
  // The findings are already written and on the deck by this point. A webhook
  // nobody is listening to must cost a log line and nothing else.
  await assert.doesNotReject(() => dispatchRaisedFindings(RAISED, slugOf));
});

test("a destination must be https, and a malformed one fails loudly", async () => {
  const { alertTarget } = await dispatcher();

  process.env.OPERATOR_ALERT_WEBHOOK_URL = "http://plain.example.com/hook";
  assert.throws(() => alertTarget(), /must be https/);

  process.env.OPERATOR_ALERT_WEBHOOK_URL = "not a url at all";
  assert.throws(() => alertTarget(), /is not a URL/);

  // Loudly at boot beats silently at 3am on the sweep that mattered.
  delete process.env.OPERATOR_ALERT_WEBHOOK_URL;
  assert.equal(alertTarget(), null);
});
