// The Bayut client (23 Nov 2026): the only code that knows Bayut's addresses.
// Every call is checked against a scripted fetch — no test reaches the network.
// The token never comes back in a message, even when Bayut repeats it.
//
// Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §2, §10, §14
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBayutClient, BAYUT_API } from "../src/lib/bayut.ts";

const TOKEN = "tok-SECRET-123";

function fakeFetch(status, body, headers = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (status instanceof Error) throw status;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  };
  return { fn, calls };
}
const client = (f) => makeBayutClient(f.fn);

test("the base address", () => {
  assert.equal(BAYUT_API, "https://api.bayut.com/v1");
});

test("create posts the body and answers the property id as text", async () => {
  const f = fakeFetch(201, { message: "Property created successfully", data: { id: 95 } });
  const body = { reference: "R1" };
  const a = await client(f).create(TOKEN, body);
  assert.deepEqual(a, { ok: true, data: { id: "95" } });
  const { url, init } = f.calls[0];
  assert.equal(url, "https://api.bayut.com/v1/properties");
  assert.equal(init.method, "POST");
  const h = new Headers(init.headers);
  assert.equal(h.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(h.get("accept"), "application/json");
  assert.equal(h.get("content-type"), "application/json");
  assert.equal(init.body, JSON.stringify(body));
  assert.ok(init.signal);
});

test("create without a property id is unreachable", async () => {
  const f = fakeFetch(201, { message: "ok" });
  const a = await client(f).create(TOKEN, {});
  assert.deepEqual(a, { ok: false, kind: "unreachable", message: "Bayut answered without a property id" });
});

test("update is a PUT of the whole body", async () => {
  const f = fakeFetch(200, { message: "Property updated successfully", data: {} });
  const a = await client(f).update(TOKEN, "95", { reference: "R1" });
  assert.deepEqual(a, { ok: true, data: null });
  assert.equal(f.calls[0].url, "https://api.bayut.com/v1/properties/95");
  assert.equal(f.calls[0].init.method, "PUT");
});

test("publish sends the portals array to products/attach", async () => {
  const f = fakeFetch(200, { message: "Product attached successfully" });
  const a = await client(f).publish(TOKEN, "95", ["bayut", "dubizzle"]);
  assert.deepEqual(a, { ok: true, data: null });
  assert.equal(f.calls[0].url, "https://api.bayut.com/v1/properties/95/products/attach");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.body, '{"portals":["bayut","dubizzle"]}');
});

test("remove is a DELETE with the portals in the body", async () => {
  const f = fakeFetch(200, { message: "Property deleted successfully!" });
  const a = await client(f).remove(TOKEN, "95", ["bayut"]);
  assert.deepEqual(a, { ok: true, data: null });
  assert.equal(f.calls[0].url, "https://api.bayut.com/v1/properties/95");
  assert.equal(f.calls[0].init.method, "DELETE");
  assert.equal(f.calls[0].init.body, '{"portals":["bayut"]}');
});

test("show lower-cases portal names and reads the permit", async () => {
  const f = fakeFetch(200, {
    data: {
      portals: [{ id: 1, name: "Bayut", state: "active" }, { id: 2, name: "dubizzle", state: "draft" }],
      permit: { number: "P1", status: "pending", comment: "Pending review" },
    },
  });
  const a = await client(f).show(TOKEN, "95");
  assert.deepEqual(a, {
    ok: true,
    data: {
      portals: [{ name: "bayut", state: "active" }, { name: "dubizzle", state: "draft" }],
      permit: { status: "pending", comment: "Pending review" },
    },
  });
  assert.equal(f.calls[0].url, "https://api.bayut.com/v1/properties/95");
  assert.equal(f.calls[0].init.method, "GET");
});

test("show with no permit answers null", async () => {
  const f = fakeFetch(200, { data: { portals: [], permit: null } });
  const a = await client(f).show(TOKEN, "95");
  assert.deepEqual(a, { ok: true, data: { portals: [], permit: null } });
});

test("list asks for one page of the agency and says whether there is a next", async () => {
  const f = fakeFetch(200, {
    data: [{ id: 7, portals: [{ name: "Bayut", state: "active" }] }, { id: 8, portals: [] }],
    links: { next: "https://api.bayut.com/v1/properties?page=3" },
  });
  const a = await client(f).list(TOKEN, 12, 2);
  assert.equal(f.calls[0].url, "https://api.bayut.com/v1/properties?agency_id=12&per_page=100&page=2");
  assert.deepEqual(a, {
    ok: true,
    data: { items: [{ id: "7", portals: [{ name: "bayut", state: "active" }] }, { id: "8", portals: [] }], next: true },
  });
  const last = await client(fakeFetch(200, { data: [], links: { next: null } })).list(TOKEN, 12, 3);
  assert.deepEqual(last, { ok: true, data: { items: [], next: false } });
});

test("locations searches by title and emirate", async () => {
  const f = fakeFetch(200, {
    data: [{ id: 5013, title: { en: "23 Marina" }, breadcrumb: { en: ["UAE", "Dubai", "Dubai Marina", "23 Marina"] } }],
  });
  const a = await client(f).locations(TOKEN, "Dubai Marina", "Dubai");
  assert.equal(f.calls[0].url, "https://api.bayut.com/v1/locations?title=Dubai%20Marina&level_2=Dubai&per_page=10");
  assert.deepEqual(a, { ok: true, data: [{ id: 5013, breadcrumb: ["UAE", "Dubai", "Dubai Marina", "23 Marina"] }] });
});

test("users read both shapes: the user itself and { data: user }", async () => {
  const f = fakeFetch(200, {
    data: [
      { id: 1, name: { en: "Ann" }, contact: { email: "ann@x.ae" } },
      { data: { id: 2, name: { en: "Bo" }, contact: { email: null } } },
    ],
  });
  const a = await client(f).users(TOKEN, 12);
  assert.ok(f.calls[0].url.startsWith("https://api.bayut.com/v1/users?agency_id=12"));
  assert.deepEqual(a, {
    ok: true,
    data: [{ id: 1, name: "Ann", email: "ann@x.ae" }, { id: 2, name: "Bo", email: null }],
  });
});

test("agencies and amenities are read plainly", async () => {
  const ag = await client(fakeFetch(200, { data: [{ id: 3, parent_id: null, name: "SFS" }, { id: 4, parent_id: 3, name: "SFS 2" }] })).agencies(TOKEN);
  assert.deepEqual(ag, { ok: true, data: [{ id: 3, parentId: null, name: "SFS" }, { id: 4, parentId: 3, name: "SFS 2" }] });
  const am = await client(fakeFetch(200, { data: [{ id: 9, title: { en: "Gym", ar: "x" } }] })).amenities(TOKEN);
  assert.deepEqual(am, { ok: true, data: [{ id: "9", title: { en: "Gym" } }] });
});

test("rejected maps each item to an id and a reason", async () => {
  const f = fakeFetch(200, {
    data: [
      { property_details: { id: 123 }, validation_details: { category: "Moderation", status_code: null, description_en: "Images are misleading" } },
      { property_details: { id: 124 }, validation_details: { category: "Permit Validation", description_en: "" } },
    ],
  });
  const a = await client(f).rejected(TOKEN);
  assert.equal(f.calls[0].url, "https://api.bayut.com/v1/properties/rejected");
  assert.deepEqual(a, {
    ok: true,
    data: [{ id: "123", reason: "Images are misleading" }, { id: "124", reason: "Permit Validation" }],
  });
});

test("401 and 403 mean the token is refused", async () => {
  const a = await client(fakeFetch(401, "Unauthenticated")).agencies(TOKEN);
  assert.deepEqual(a, { ok: false, kind: "token-refused", message: "HTTP 401" });
  const b = await client(fakeFetch(403, { message: "The action is not authorized." })).agencies(TOKEN);
  assert.deepEqual(b, { ok: false, kind: "token-refused", message: "The action is not authorized." });
});

test("409 is busy", async () => {
  const a = await client(fakeFetch(409, { message: "Please wait! Your request is being processed." })).publish(TOKEN, "1", ["bayut"]);
  assert.deepEqual(a, { ok: false, kind: "busy", message: "Please wait! Your request is being processed." });
});

test("429 is rate-limited with Bayut's retry_after, else 60", async () => {
  const a = await client(fakeFetch(429, { error: "Rate limit exceeded", message: "Rate limit exceeded", retry_after: 17 })).agencies(TOKEN);
  assert.deepEqual(a, { ok: false, kind: "rate-limited", message: "Rate limit exceeded", retryAfter: 17 });
  const b = await client(fakeFetch(429, "slow down")).agencies(TOKEN);
  assert.equal(b.kind, "rate-limited");
  assert.equal(b.retryAfter, 60);
});

test("422 with an object of errors gives message, field and the first error", async () => {
  const f = fakeFetch(422, {
    message: "The given data was invalid.",
    errors: { category: ["The selected category is invalid.", "second"], price: ["Too low."] },
  });
  const a = await client(f).create(TOKEN, {});
  assert.equal(a.kind, "refused");
  assert.equal(a.message, "The given data was invalid. category: The selected category is invalid. price: Too low.");
});

test("422 with an array of string arrays (permit validate) appends the first string", async () => {
  const f = fakeFetch(422, { message: "The given data was invalid.", errors: [["The listing has failed the ADREC check"]] });
  const a = await client(f).update(TOKEN, "1", {});
  assert.deepEqual(a, { ok: false, kind: "refused", message: "The given data was invalid. The listing has failed the ADREC check." });
});

test("other 4xx are refused; a non-JSON body falls back to the status", async () => {
  const a = await client(fakeFetch(404, { message: "Not Found" })).remove(TOKEN, "1", ["bayut"]);
  assert.deepEqual(a, { ok: false, kind: "refused", message: "Not Found" });
  const b = await client(fakeFetch(400, "<html>")).show(TOKEN, "1");
  assert.deepEqual(b, { ok: false, kind: "refused", message: "HTTP 400" });
});

test("5xx is unreachable", async () => {
  const a = await client(fakeFetch(503, { message: "Down" })).agencies(TOKEN);
  assert.deepEqual(a, { ok: false, kind: "unreachable", message: "HTTP 503" });
});

test("a network failure and a 15-second timeout are unreachable", async () => {
  const a = await client(fakeFetch(new Error("connect ECONNREFUSED"), "")).agencies(TOKEN);
  assert.deepEqual(a, { ok: false, kind: "unreachable", message: "connect ECONNREFUSED" });
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const b = await client(fakeFetch(timeout, "")).agencies(TOKEN);
  assert.equal(b.ok, false);
  assert.equal(b.kind, "unreachable");
});

test("the 15-second timeout is armed on every call", async () => {
  const f = fakeFetch(200, { data: [] });
  await client(f).agencies(TOKEN);
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
});

test("the token never comes back in a message", async () => {
  const f = fakeFetch(422, {
    message: `Bad request for Bearer ${TOKEN}`,
    errors: { reference: [`echo ${TOKEN} here`] },
  });
  const a = await client(f).create(TOKEN, {});
  assert.equal(a.ok, false);
  assert.ok(!a.message.includes(TOKEN));
  assert.ok(a.message.includes("•••"));
  const n = await client(fakeFetch(new Error(`failed with ${TOKEN}`), "")).agencies(TOKEN);
  assert.ok(!n.message.includes(TOKEN));
});

test("a message is at most 300 characters", async () => {
  const a = await client(fakeFetch(422, { message: "x".repeat(900) })).create(TOKEN, {});
  assert.equal(a.message.length, 300);
});
