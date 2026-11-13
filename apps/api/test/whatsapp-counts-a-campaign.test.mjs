// WhatsApp's own count of a campaign (13 Nov 2026).
//
// Meta's dashboard knew the first SFS campaign reached 150 phones and cost
// AED 32.89; Nexus, fed four delivery receipts, said "Delivered 4" -- and the
// owner asked "how much it cost" twice, because Nexus could not say. Meta
// answers both through its analytics for a number over a stretch of time, so the
// Bulk page now shows that beside each recent campaign.
//
// A campaign's stretch is the day after its first send, in Meta's half-hour
// steps, cut short by the next campaign from the same number so two campaigns
// never share a count. Meta not answering shows nothing -- never a made-up zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countingPeriod, countFrom, readWhatsAppCount, whatsAppCountsFor } from "../src/lib/whatsapp-count.ts";

const at = (iso) => new Date(iso);
const HALF_HOUR = 1800;

test("a campaign is counted for the day after its first send, from the half hour it began in", () => {
  const period = countingPeriod(at("2026-11-12T12:00:05Z"), null, at("2026-11-14T09:00:00Z"));
  assert.equal(period.start, Date.UTC(2026, 10, 12, 12, 0, 0) / 1000);
  assert.equal(period.end, period.start + 86_400);
});

test("a campaign still inside its day is counted up to now", () => {
  const period = countingPeriod(at("2026-11-12T12:10:00Z"), null, at("2026-11-12T13:05:00Z"));
  assert.equal(period.start, Date.UTC(2026, 10, 12, 12, 0, 0) / 1000);
  assert.equal(period.end, Date.UTC(2026, 10, 12, 13, 30, 0) / 1000, "the half hour now is in, whole");
});

test("the next campaign from the same number ends the count, so the two never share one", () => {
  const period = countingPeriod(at("2026-11-12T12:00:05Z"), at("2026-11-12T18:40:00Z"), at("2026-11-14T09:00:00Z"));
  assert.equal(period.end, Date.UTC(2026, 10, 12, 18, 30, 0) / 1000);
});

test("two campaigns inside one half hour cannot be told apart, so neither is counted", () => {
  assert.equal(countingPeriod(at("2026-11-12T12:00:05Z"), at("2026-11-12T12:20:00Z"), at("2026-11-14T09:00:00Z")), null);
});

// The shapes on developers.facebook.com/documentation/business-messaging/whatsapp/analytics.
const messaging = {
  analytics: {
    phone_numbers: ["971504805436"],
    granularity: "HALF_HOUR",
    data_points: [
      { start: 1794484800, end: 1794486600, sent: 152, delivered: 141 },
      { start: 1794486600, end: 1794488400, sent: 0, delivered: 9 },
    ],
  },
  id: "27906775185687997",
};
const pricing = {
  currency: "AED",
  pricing_analytics: {
    data: [
      {
        data_points: [
          { start: 1794484800, end: 1794486600, pricing_type: "REGULAR", pricing_category: "MARKETING", volume: 141, cost: 32.2 },
          { start: 1794486600, end: 1794488400, pricing_type: "REGULAR", pricing_category: "MARKETING", volume: 3, cost: 0.69 },
          { start: 1794486600, end: 1794488400, pricing_type: "FREE_CUSTOMER_SERVICE", pricing_category: "SERVICE", volume: 6, cost: 0 },
        ],
      },
    ],
  },
  id: "27906775185687997",
};

// What Meta really sent on 13 Nov 2026, live, when asked for volumes alone: no cost on any point.
const volumesOnly = {
  currency: "AED",
  pricing_analytics: {
    data: [
      {
        data_points: [
          { start: 1794484800, end: 1794486600, pricing_type: "REGULAR", pricing_category: "MARKETING", volume: 142 },
          { start: 1794484800, end: 1794486600, pricing_type: "FREE_CUSTOMER_SERVICE", pricing_category: "SERVICE", volume: 6 },
          { start: 1794486600, end: 1794488400, pricing_type: "REGULAR", pricing_category: "MARKETING", volume: 3 },
        ],
      },
    ],
  },
};

test("delivered is Meta's count of template messages; the cost is what it charged, in the account's currency", () => {
  assert.deepEqual(countFrom(messaging, pricing), { delivered: 150, cost: 32.89, currency: "AED" });
});

test("without the charges, the count still shows -- and says nothing about money", () => {
  assert.deepEqual(countFrom(messaging, null), { delivered: 150, cost: null, currency: null });
});

test("without the message count, the template messages Meta priced stand in for it", () => {
  // 141 + 3 marketing. The 6 free replies inside the customer's window are
  // conversation, not campaign, and are left out.
  assert.deepEqual(countFrom(null, pricing), { delivered: 144, cost: 32.89, currency: "AED" });
});

test("an answer with no charges in it says nothing about money -- never a made-up zero", () => {
  // What Meta really sent on 13 Nov 2026, live: asked without metric_types, every
  // point came back with a volume and NO cost. Read as 0, the first SFS campaign
  // would have "cost nothing" where Meta's dashboard said AED 32.89.
  assert.deepEqual(countFrom(messaging, volumesOnly), { delivered: 150, cost: null, currency: "AED" });
  assert.deepEqual(countFrom(null, volumesOnly), { delivered: 145, cost: null, currency: "AED" });
});

test("nothing from Meta is nothing -- not a zero", () => {
  assert.equal(countFrom(null, null), null);
  assert.equal(countFrom({ error: { message: "Unsupported get request" } }, { error: { message: "nope" } }), null);
});

test("a quiet period Meta did answer for is a real zero", () => {
  assert.deepEqual(countFrom({ analytics: { granularity: "HALF_HOUR" }, id: "1" }, { currency: "USD", pricing_analytics: { data: [] }, id: "1" }), {
    delivered: 0,
    cost: 0,
    currency: "USD",
  });
});

/** Meta, stood in: answers by what the request asks for, and remembers the requests. */
function metaAnswering(answers) {
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const text = decodeURIComponent(String(url));
    asked.push({ url: text, auth: init?.headers?.Authorization });
    const key = text.includes("display_phone_number") ? "number" : text.includes("pricing_analytics") ? "pricing" : "messaging";
    // The request that names COST may be answered differently from the one that does not.
    const answer = key === "pricing" && text.includes("metric_types") && answers.pricingWithCost ? answers.pricingWithCost : answers[key];
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { asked, restore: () => (globalThis.fetch = realFetch) };
}
const ask = { phoneNumberId: "1380783455114080", wabaId: "27906775185687997", start: 1794484800, end: 1794571200, token: "probe-token" };

test("Meta is asked about that number only, template messages only, in half hours, with the number's own key", async () => {
  const meta = metaAnswering({ number: { body: { display_phone_number: "+971 50 480 5436" } }, messaging: { body: messaging }, pricing: { body: pricing } });
  try {
    assert.deepEqual(await readWhatsAppCount(ask), { delivered: 150, cost: 32.89, currency: "AED" });
  } finally {
    meta.restore();
  }
  const m = meta.asked.find((request) => request.url.includes("fields=analytics"));
  assert.match(m.url, /\/27906775185687997\?fields=analytics\.start\(1794484800\)\.end\(1794571200\)\.granularity\(HALF_HOUR\)/);
  assert.match(m.url, /\.phone_numbers\(\["971504805436"\]\)/, "digits only, as Meta lists its numbers");
  assert.match(m.url, /\.product_types\(\[0\]\)/, "template messages: what a campaign sends");
  const p = meta.asked.find((request) => request.url.includes("pricing_analytics"));
  assert.match(p.url, /fields=currency,pricing_analytics\.start\(1794484800\)\.end\(1794571200\)\.granularity\(HALF_HOUR\)\.phone_numbers\(\["971504805436"\]\)/);
  assert.match(p.url, /\.metric_types\(\["COST","VOLUME"\]\)/, "asked for outright: left out, Meta sends volumes and no charges");
  assert.ok(meta.asked.every((request) => request.auth === "Bearer probe-token"));
});

test("Meta refusing the charges still leaves the count; Meta refusing both leaves nothing", async () => {
  let meta = metaAnswering({ number: { body: { display_phone_number: "+971 50 480 5436" } }, messaging: { body: messaging }, pricing: { status: 400, body: { error: { message: "(#100) Tried accessing nonexisting field (pricing_analytics)" } } } });
  try {
    assert.deepEqual(await readWhatsAppCount(ask), { delivered: 150, cost: null, currency: null });
  } finally {
    meta.restore();
  }
  meta = metaAnswering({ number: { body: { display_phone_number: "+971 50 480 5436" } }, messaging: new Error("socket hang up"), pricing: { status: 403, body: { error: { message: "no" } } } });
  try {
    assert.equal(await readWhatsAppCount(ask), null);
  } finally {
    meta.restore();
  }
});

test("Meta keeps the charges of an account connected through a partner app; the count still comes", async () => {
  // Live, 13 Nov 2026, the SFS account: "(#10) Application does not have permission
  // for this action -- COST is not shown for businesses who bill through a partner".
  // Nexus connects numbers as a partner app, so this is every customer's account.
  const refusal = { status: 400, body: { error: { message: "Application does not have permission for this action", code: 10, error_subcode: 2388184 } } };
  const meta = metaAnswering({ number: { body: { display_phone_number: "+971 50 480 5436" } }, messaging: { body: messaging }, pricingWithCost: refusal, pricing: { body: volumesOnly } });
  try {
    assert.deepEqual(await readWhatsAppCount(ask), { delivered: 150, cost: null, currency: "AED" });
  } finally {
    meta.restore();
  }
  const priced = meta.asked.filter((request) => request.url.includes("pricing_analytics"));
  assert.equal(priced.length, 2, "asked again, for the volumes alone");
  assert.doesNotMatch(priced[1].url, /metric_types/);
});

test("a number Meta will not name cannot be asked about", async () => {
  const meta = metaAnswering({ number: { status: 400, body: { error: { message: "gone" } } }, messaging: { body: messaging }, pricing: { body: pricing } });
  try {
    assert.equal(await readWhatsAppCount(ask), null);
    assert.equal(meta.asked.length, 1, "nothing further was asked");
  } finally {
    meta.restore();
  }
});

/** A cache that lives for one test. */
const memory = () => {
  const kept = new Map();
  return { kept, get: async (id) => kept.get(id)?.value ?? null, set: async (id, value, seconds) => void kept.set(id, { value, seconds }) };
};
const NOW = at("2026-11-13T09:00:00Z");
const campaigns = [
  { id: "c-new", fromPhoneNumberId: "N1", firstSentAt: "2026-11-13T08:10:00Z" }, // 50 minutes ago
  { id: "c-old", fromPhoneNumberId: "N1", firstSentAt: "2026-11-10T08:00:00Z" },
  { id: "c-gone", fromPhoneNumberId: "N9", firstSentAt: "2026-11-09T08:00:00Z" }, // its number is no longer connected
];
const account = async (phoneNumberId) => (phoneNumberId === "N1" ? { wabaId: "W1", token: "t1" } : null);

test("each recent campaign gets the count for its own number and stretch; one whose number is gone gets none", async () => {
  const read = [];
  const counts = await whatsAppCountsFor(campaigns, {
    account,
    cache: memory(),
    now: NOW,
    read: async (input) => {
      read.push(input);
      return { delivered: input.start, cost: 1, currency: "AED" };
    },
  });
  assert.deepEqual(Object.keys(counts).sort(), ["c-new", "c-old"]);
  const old = read.find((input) => input.start === Date.UTC(2026, 10, 10, 8, 0, 0) / 1000);
  assert.equal(old.end, old.start + 86_400, "a whole day: the next campaign came three days later");
  assert.deepEqual({ phoneNumberId: old.phoneNumberId, wabaId: old.wabaId, token: old.token }, { phoneNumberId: "N1", wabaId: "W1", token: "t1" });
  const fresh = read.find((input) => input.start === Date.UTC(2026, 10, 13, 8, 0, 0) / 1000);
  assert.equal(fresh.end, Date.UTC(2026, 10, 13, 9, 0, 0) / 1000, "up to now");
});

test("a settled count is kept a week, a moving one ten minutes, and a kept count is not asked for again", async () => {
  const cache = memory();
  let asked = 0;
  const read = async () => (asked++, { delivered: 5, cost: null, currency: null });
  await whatsAppCountsFor(campaigns, { account, cache, now: NOW, read });
  assert.equal(asked, 2);
  assert.equal(cache.kept.get("c-old").seconds, 7 * 86_400);
  assert.equal(cache.kept.get("c-new").seconds, 600);
  const again = await whatsAppCountsFor(campaigns, { account, cache, now: NOW, read });
  assert.equal(asked, 2, "both came from the cache");
  assert.deepEqual(again["c-old"], { delivered: 5, cost: null, currency: null });
});

test("Meta not answering is not kept, and the page simply shows no count", async () => {
  const cache = memory();
  const counts = await whatsAppCountsFor(campaigns, { account, cache, now: NOW, read: async () => null });
  assert.deepEqual(counts, {});
  assert.equal(cache.kept.size, 0);
});

test("only the five newest campaigns are asked about", async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, fromPhoneNumberId: "N1", firstSentAt: new Date(NOW.getTime() - (i + 1) * 2 * 86_400_000).toISOString() }));
  let asked = 0;
  await whatsAppCountsFor(many, { account, cache: memory(), now: NOW, read: async () => (asked++, { delivered: 1, cost: null, currency: null }) });
  assert.equal(asked, 5);
});
