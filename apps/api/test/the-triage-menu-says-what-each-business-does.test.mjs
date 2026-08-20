// The menu asked strangers a question they could not answer.
//
// Every customer who arrives without a #tag sees it, and it listed names only:
//
//   1. ABR Advocates & Legal Consultants
//   2. Juris Prime
//   3. Juris Prime Legal
//   4. SFS International
//   5. Zipicka
//
// Three of the five are law firms and two of them are "Juris Prime" and "Juris
// Prime Legal". Somebody who wants a degree certificate attested has no way to
// tell which of those to pick; a person with a rent dispute has three plausible
// answers. Choosing wrong routes them to a firm that cannot help and makes
// their first impression of all five a wasted exchange. This is the fallback
// for every untagged arrival, so it gets more traffic the moment the deep
// links are published, not less.
//
// The hints are the businesses' OWN routing keywords — the terms each one
// configured as "this enquiry is mine". Writing descriptions for five real
// companies would be putting words in their mouths on their own number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTriageMessage } from "../../../packages/agents/src/business-router.ts";

/** The live registry's keywords, bilingual and interleaved exactly as stored. */
const LIVE = [
  { id: "1", slug: "abr", name: "ABR Advocates & Legal Consultants",
    routingKeywords: ["legal", "التحكيم", "محامون", "defence", "patent", "محامي", "arrest", "fidic"] },
  { id: "2", slug: "juris-prime", name: "Juris Prime",
    routingKeywords: ["apostille", "ترجمة", "mofa", "تصديقات", "notary", "السفارة"] },
  { id: "3", slug: "juris-prime-legal", name: "Juris Prime Legal",
    routingKeywords: ["agreement", "partnership", "اتفاقية", "الوصية", "قانوني", "legal consultation"] },
  { id: "4", slug: "sfs-international", name: "SFS International",
    routingKeywords: ["ايجار", "إيجار", "flat", "apartment", "استثمار عقاري", "rental", "شقة"] },
  { id: "5", slug: "zipicka", name: "Zipicka",
    routingKeywords: ["شحن", "shop", "order", "تسوق", "essentials"] },
];

const english = () => buildTriageMessage(LIVE, "hello I need some help");
const arabic = () => buildTriageMessage(LIVE, "مرحبا احتاج مساعدة");

test("the two law firms can finally be told apart", () => {
  const menu = english();
  assert.match(menu, /Juris Prime — apostille, mofa, notary/);
  assert.match(menu, /Juris Prime Legal — agreement, partnership, legal consultation/);
  // Which is the whole point: attestation and disputes are now distinguishable
  // without knowing either brand.
});

test("a customer only sees terms in the script they wrote in", () => {
  // The keyword lists interleave scripts — ABR's begin "legal, التحكيم,
  // محامون, defence". Taking the first three verbatim would hand an English
  // speaker two words they cannot read, on the one message that exists to be
  // answered.
  const en = english();
  assert.ok(!/\p{Script=Arabic}/u.test(en.split("\n").filter((l) => /^\d\./.test(l)).join(" ")),
    "an English menu must not carry Arabic hints");

  const ar = arabic();
  const arHints = ar.split("\n").filter((l) => /^\d\./.test(l)).map((l) => l.split("—")[1] ?? "");
  assert.ok(arHints.every((h) => !/[a-z]{3,}/i.test(h)), "an Arabic menu must not carry English hints");
});

test("the same word spelled two ways appears once", () => {
  // SFS lists "ايجار" and "إيجار" — one word, with and without the hamza,
  // because both are typed and both must route. Correct for matching, a
  // stutter in a menu: two of the three things said about that firm would be
  // one thing twice.
  const line = arabic().split("\n").find((l) => l.startsWith("4."));
  assert.ok(line, "SFS is missing from the menu");
  assert.equal((line.match(/ايجار|إيجار/g) ?? []).length, 1, `the duplicate survived: ${line}`);
  // And the freed slot is used, rather than the hint just being shorter.
  assert.match(line, /شقة/);
});

test("the Arabic menu uses an Arabic comma", () => {
  // The rest of that message is written with Arabic punctuation. A Latin comma
  // in the middle of it is the kind of detail a reader notices without being
  // able to say why.
  const line = arabic().split("\n").find((l) => l.startsWith("2."));
  assert.match(line, /،/);
  assert.ok(!line.includes(", "), `a Latin comma is in the Arabic menu: ${line}`);
});

test("a business with no terms in that script is shown plainly", () => {
  // Never annotated with characters the reader cannot use, and never invented.
  const englishOnly = [{ id: "9", slug: "x", name: "Example Co", routingKeywords: ["widgets"] }];
  const menu = buildTriageMessage(englishOnly, "مرحبا");
  assert.match(menu, /1\. Example Co\n/);
  assert.ok(!menu.includes("widgets"), "an Arabic reader was shown an English hint");
});

test("the numbering a customer replies with is untouched", () => {
  // The ordinal is what they answer with. Adding hints must not shift it.
  const menu = english();
  for (const [i, b] of LIVE.entries()) {
    assert.ok(menu.includes(`${i + 1}. ${b.name}`), `option ${i + 1} lost its name`);
  }
});
