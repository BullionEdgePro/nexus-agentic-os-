// A Facebook Page connected is the business's own (audit, 4 Nov 2026).
//
// Connecting saved whichever Page Meta listed first. An admin whose Facebook
// account manages several businesses' Pages could connect Zipicka's Page as
// SFS's channel -- Zipicka's Messenger customers then landed in SFS's inbox and
// SFS's agent answered them. No guessing now: a Page named for the business
// (whole words), or the account's only Page, or a refusal that lists them; and
// the route refuses a Page another business already has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { chooseFacebookPage } = await import("../src/lib/facebook-page-choice.ts");

const page = (pageId, name, instagram = null) => ({ pageId, name, pageAccessToken: "t", instagram });
const ZIPICKA = page("1", "Zipicka Store", { id: "z", username: "zipicka" });
const SFS = page("2", "SFS International Real Estate");
const OTHER = page("3", "Family Photos");

test("an account's only Page is the one", () => {
  assert.equal(chooseFacebookPage([SFS], "SFS International", "facebook")?.pageId, "2");
});

test("among several, the one named for the business", () => {
  assert.equal(chooseFacebookPage([ZIPICKA, SFS, OTHER], "SFS International", "facebook")?.pageId, "2");
  assert.equal(chooseFacebookPage([ZIPICKA, SFS], "Zipicka", "facebook")?.pageId, "1");
});

test("for Instagram, the business's own Page with an Instagram account -- never another's", () => {
  assert.equal(chooseFacebookPage([SFS, ZIPICKA], "Zipicka", "instagram")?.pageId, "1");
  // Review, 4 Nov 2026: the only Page with Instagram was taken whatever its name,
  // so SFS could be given Zipicka's Instagram.
  assert.equal(chooseFacebookPage([SFS, ZIPICKA], "SFS International", "instagram"), null);
});

test("names match on whole words", () => {
  assert.equal(chooseFacebookPage([page("4", "Fabric House"), OTHER], "ABR", "facebook"), null);
});

test("when it cannot tell, it does not guess", () => {
  assert.equal(chooseFacebookPage([ZIPICKA, OTHER], "SFS International", "facebook"), null);
});

test("a Page another business already has is refused", () => {
  const route = readFileSync(new URL("../src/routes/connections.ts", import.meta.url), "utf8");
  const callback = route.slice(route.indexOf("const page = chooseFacebookPage("));
  assert.match(callback.slice(0, 1600), /organizationForConnectedPage\(/);
  assert.match(callback.slice(0, 1600), /is already connected to another business/);
});
