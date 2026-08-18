// The owner's own dashboard showed six invented figures.
//
// `/` is behind the login — it is what the person running these businesses sees
// when they sign in. Until 2026-08-18 it rendered, whenever the platform had no
// traffic OR the API could not be reached:
//
//   Active conversations  128     +12 vs 1h
//   AI resolution          87%    +3.1 pts
//   Messages today      1,402     +18% vs avg
//   Avg first response    2.4s    −0.6s faster
//   Governance holds        6     3 PII · 3 risk
//   Tokens used          214k     $5.10 est.
//
// The real numbers are around a dozen AI replies in total. And the fallback
// applied on FETCH FAILURE too, so an unreachable API rendered as a busy,
// healthy business — the one failure mode this platform keeps meeting in new
// clothes, and one already fixed once on /deck/quality for the same reason.
//
// Half of it had already been noticed: the activity feed carries the comment
// "Empty on purpose. This used to hold five invented conversations". The
// fabricated conversations were removed and the fabricated statistics above
// them were left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const CONSOLE = read("apps", "web", "app", "deck-console.tsx");
const code = CONSOLE.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, " ").replace(/^[ \t]*\/\/[^\n]*/gm, " ");

test("none of the invented figures survives in rendered code", () => {
  // Matched against the source with comments stripped, because the comment
  // explaining the removal quotes every one of them.
  for (const invented of ["128", "1,402", "+3.1 pts", "+18% vs avg", "$5.10 est.", "3 PII"]) {
    assert.ok(
      !code.includes(invented),
      `"${invented}" is still rendered — it was one of the invented dashboard figures`
    );
  }

  // The intent mix went with them: a plausible retail funnel (inventory 38,
  // bookings 27) for a platform whose real distribution is roughly half people
  // selling TO the businesses. A shape that looks healthy is worse than a blank
  // panel, because nobody questions it.
  assert.match(code, /const INTENTS: \{ n: string; v: number \}\[\] = \[\];/);
});

test("the labels stay, so an empty dashboard still says what it would show", () => {
  assert.match(code, /const NO_DATA: Stat\[\]/);
  for (const label of ["Active conversations", "AI resolution", "Messages today", "Tokens used"]) {
    assert.ok(code.includes(label), `${label} should still be listed`);
  }
  // Values are an em dash and the sparklines are empty — no shape either.
  assert.match(code, /\{ k: "Active conversations", v: "—", d: "", cls: "flat", spark: \[\], hi: true \}/);
});

test("an unreachable API is not the same silence as an empty platform", () => {
  // The old code kept the sample on any error, so the two were indistinguishable
  // and both looked like a thriving business. "Nothing has happened yet" is news
  // about the platform; "nobody could ask" is news about this page.
  assert.match(code, /setUnreachable\(true\)/);
  assert.match(code, /unreachable\s*\n?\s*\? "could not reach the API"/);
  assert.match(code, /: overview\s*\n?\s*\? "no traffic yet"/);

  // And a third state before either is known, so a slow load does not read as
  // an empty platform for the second it takes.
  assert.match(code, /"loading…"/);
});

test("the sample is not still reachable under another name", () => {
  // A rename would satisfy every assertion above while restoring the behaviour.
  assert.ok(!/\bconst STATS\b/.test(code), "the sample stats array must be gone, not renamed");
  assert.ok(!/: STATS\b/.test(code), "nothing may fall back to a sample stats array");
});
