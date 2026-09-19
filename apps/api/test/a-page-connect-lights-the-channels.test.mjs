// Connecting a Facebook Page is the one act that turns the dormant FB/IG channels
// live.
//
// Slices 1–4 built parse, identity, inbound ingest and outbound send, and left
// them waiting on two resolvers with nothing to read: organizationForConnectedPage
// (inbound) and pageConnectionForOutbound (outbound). This flow writes exactly the
// rows those read. The correctness is in the OAuth shape, the Graph calls, and —
// most of all — WHICH id each stored row is keyed on, since inbound resolves a
// Page delivery by entry.id (the Page id) and an Instagram delivery by the IG
// account id. So this pins those as text, the way the rest of the channel suite does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const ONBOARDING = read("apps", "api", "src", "lib", "facebook-onboarding.ts");
const ROUTES = read("apps", "api", "src", "routes", "connections.ts");

test("the authorize URL asks Facebook for the messaging permissions, as a code flow", () => {
  assert.match(ONBOARDING, /dialog\/oauth/);
  assert.match(ONBOARDING, /response_type", "code"/);
  assert.match(ONBOARDING, /client_id", env\.metaAppId/);
  for (const scope of ["pages_messaging", "pages_show_list", "pages_manage_metadata", "instagram_manage_messages", "instagram_basic"]) {
    assert.ok(ONBOARDING.includes(scope), `the connect must request ${scope}`);
  }
});

test("Facebook and Instagram ask for SEPARATE scope sets", () => {
  // Two connects, each asking only for its channel. Connecting the Page must not
  // make a person grant Instagram access, so the Facebook set carries no
  // instagram_* scope; the Instagram set carries the IG permissions plus the page
  // access it rides on.
  assert.match(ONBOARDING, /export function facebookScopes/);
  assert.match(ONBOARDING, /export function instagramScopes/);
  const fbBlock = ONBOARDING.slice(
    ONBOARDING.indexOf("const FACEBOOK_PAGE_SCOPES = ["),
    ONBOARDING.indexOf("const INSTAGRAM_SCOPES = [")
  );
  assert.ok(fbBlock.includes("pages_messaging"), "the Facebook set must carry pages_messaging");
  assert.ok(!fbBlock.includes("instagram_"), "the Facebook set must NOT carry any instagram_ scope");
  const igBlock = ONBOARDING.slice(
    ONBOARDING.indexOf("const INSTAGRAM_SCOPES = ["),
    ONBOARDING.indexOf("function scopesFrom")
  );
  assert.ok(igBlock.includes("instagram_manage_messages"), "the Instagram set must carry instagram_manage_messages");
});

test("the code is exchanged for a LONG-LIVED token, in two hops", () => {
  // A page token minted from a long-lived user token does not expire, which is
  // what a channel that must keep answering needs.
  assert.match(ONBOARDING, /grant_type: "fb_exchange_token"/);
  assert.match(ONBOARDING, /fb_exchange_token: shortToken/);
});

test("the Page's OWN token and its linked Instagram are read together", () => {
  assert.match(ONBOARDING, /me\/accounts/);
  assert.match(ONBOARDING, /instagram_business_account\{id,username\}/);
  // The stored credential is the per-Page access token, never the user token.
  assert.match(ONBOARDING, /pageAccessToken: typeof page\.access_token === "string"/);
});

test("the Page is subscribed to message webhooks, or nothing is ever delivered", () => {
  assert.match(ONBOARDING, /subscribed_apps/);
  assert.match(ONBOARDING, /subscribed_fields: "messages,messaging_postbacks"/);
});

test("the connect is off until the shared Meta app is configured", () => {
  assert.match(ONBOARDING, /export function facebookConfigured/);
  assert.match(ONBOARDING, /env\.metaAppId && process\.env\.META_APP_SECRET/);
});

test("a connected Page is stored at the business level, keyed by the Page id", () => {
  // employeeId null: a Page belongs to the business, which is exactly what
  // pageConnectionForOutbound (employee_id is null) and the inbound resolver read.
  assert.match(ROUTES, /provider: "facebook",\s*\n\s*externalId: page\.pageId/);
  assert.match(ROUTES, /employeeId: null,\s*\n\s*provider: "facebook"/);
});

test("the linked Instagram is stored under ITS OWN id, not the Page id", () => {
  // An IG webhook arrives as object 'instagram' with entry.id = the IG account
  // id; organizationForConnectedPage must find THAT. Keying the IG row on the
  // Page id would make every inbound Instagram message unroutable.
  assert.match(ROUTES, /provider: "instagram",\s*\n\s*externalId: page\.instagram!\.id/);
});

test("the connected token is the page token, stored not-expiring", () => {
  assert.match(ROUTES, /accessToken: page\.pageAccessToken/);
  assert.match(ROUTES, /expiresAt: null/);
});

test("Facebook and Instagram are two separate connects sharing one callback", () => {
  // Two start routes, one shared callback; the state's `target` decides which row
  // the callback writes, so connecting one never writes the other.
  assert.match(ROUTES, /connectionsRoute\.get\("\/facebook\/start"/);
  assert.match(ROUTES, /connectionsRoute\.get\("\/instagram\/start"/);
  assert.match(ROUTES, /connectionsRoute\.get\("\/facebook\/callback"/);
  assert.match(ROUTES, /startFacebookLogin\(c, "facebook", facebookScopes\(\)\)/);
  assert.match(ROUTES, /startFacebookLogin\(c, "instagram", instagramScopes\(\)\)/);
  // The callback writes only the target channel.
  assert.match(ROUTES, /const target = state\.target \?\? "facebook"/);
  assert.match(ROUTES, /if \(target === "facebook"\)/);
});

test("connecting Instagram with no linked IG is refused, not stored as a Page", () => {
  assert.match(ROUTES, /if \(target === "instagram" && !page\.instagram\)/);
  assert.match(ROUTES, /no Instagram Business account linked/i);
});

test("the connect flow is protected exactly like the other OAuth callbacks", () => {
  // Signed state cookie + login throttle + single-use clearing — the TikTok
  // callback's protections, not a weaker home-grown set.
  assert.match(ROUTES, /recordLoginFailure\(source, "facebook-callback"\)/);
  assert.match(ROUTES, /signState\(\{[\s\S]*provider: "facebook"/);
});

test("the panel is told about BOTH channels, and told the truth about the Meta gate", () => {
  assert.match(ROUTES, /id: "facebook"/);
  assert.match(ROUTES, /id: "instagram"/);
  assert.match(ROUTES, /App Review/);
  // The UI shows each Connect button only when the provider reports configured —
  // both entries MUST carry that flag (the bug this asserts against).
  assert.match(ROUTES, /id: "facebook",[\s\S]*?configured: facebookConfigured\(\)/);
  assert.match(ROUTES, /id: "instagram",[\s\S]*?configured: facebookConfigured\(\)/);
});
