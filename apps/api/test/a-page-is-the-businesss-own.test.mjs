// A Facebook Page connected is the business's own (audit, 4 Nov 2026).
//
// Connecting saved whichever Page Meta listed first. An admin whose Facebook
// account manages several businesses' Pages could connect Zipicka's Page as
// SFS's channel -- Zipicka's Messenger customers then landed in SFS's inbox and
// SFS's agent answered them. And for Instagram, a first Page with no Instagram
// account was refused even when another had one. No guessing now: the only
// Page that fits, or the one named for the business, or a refusal that lists
// the Pages.
import { test } from "node:test";
import assert from "node:assert/strict";

const { chooseFacebookPage } = await import("../src/lib/facebook-page-choice.ts");

const page = (pageId, name, instagram = null) => ({ pageId, name, pageAccessToken: "t", instagram });
const ZIPICKA = page("1", "Zipicka Store", { igUserId: "z", username: "zipicka" });
const SFS = page("2", "SFS International Real Estate");
const OTHER = page("3", "Family Photos");

test("the only Page there is, is the one", () => {
  assert.equal(chooseFacebookPage([SFS], "SFS International", "facebook")?.pageId, "2");
});

test("among several, the one named for the business", () => {
  assert.equal(chooseFacebookPage([ZIPICKA, SFS, OTHER], "SFS International", "facebook")?.pageId, "2");
  assert.equal(chooseFacebookPage([ZIPICKA, SFS], "Zipicka", "facebook")?.pageId, "1");
});

test("for Instagram, the Page that has an Instagram account", () => {
  assert.equal(chooseFacebookPage([SFS, ZIPICKA], "Anything", "instagram")?.pageId, "1");
});

test("when it cannot tell, it does not guess", () => {
  assert.equal(chooseFacebookPage([ZIPICKA, OTHER], "SFS International", "facebook"), null);
});
