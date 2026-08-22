/**
 * The loop's teeth: a mistake made three times must be caught by something.
 *
 * ============================================================
 * WHY THIS IS A TEST AND NOT A GATE
 * ============================================================
 *
 * The ten gates in verify-all.sh run against production, on the VPS, and answer
 * questions only production can answer. This one reads source, so its answer is
 * the same everywhere and it should be answered as early as possible — at the
 * commit, not after the deploy. `npm test` is what the pre-commit hook runs, so
 * putting it here means the check happens before the mistake can travel.
 *
 * There is also a plain reason: the VPS has no node outside the containers, and
 * the test files are not in the images. A gate placed in verify-all.sh would
 * have looked like coverage and run nowhere.
 *
 * ============================================================
 * WHAT IT ENFORCES
 * ============================================================
 *
 * Two things, and the second is the one that matters.
 *
 * First, every detector runs, and any finding fails. That is the ordinary half.
 *
 * Second, the register must stay honest: a class recorded as having recurred
 * three times or more must name something that catches it, or state in writing
 * why nothing can. This is what stops the register decaying into the thing it
 * replaced — a list of laments. A class cannot sit at eleven instances with an
 * empty coverage field and a shrug.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { CLASSES, COVERAGE_REQUIRED_AT } from "../../../scripts/recurrence/register.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DETECTOR_DIR = join(here, "..", "..", "..", "scripts", "recurrence", "detectors");

const detectorFiles = readdirSync(DETECTOR_DIR).filter((f) => f.endsWith(".mjs"));
// pathToFileURL rather than "file://" + path: this repository lives under a
// directory with a space in it locally and under /opt/nexus in production, and
// hand-built file URLs get exactly one of those two right.
const detectors = await Promise.all(
  detectorFiles.map((f) => import(pathToFileURL(join(DETECTOR_DIR, f)).href))
);

for (const detector of detectors) {
  test(`no live instance of ${detector.id}`, () => {
    const result = detector.detect();

    // A detector that checked nothing is not a passing detector. Every one of
    // these has already been silently broken once -- the prose scanner resolved
    // every path three levels too deep and reported a clean tree while checking
    // two assertions out of 219. Zero findings and zero checks look identical
    // from outside, so the count is asserted rather than trusted.
    assert.ok(
      result.checked > 0,
      `${detector.id} examined nothing at all. Either the tree changed shape or the ` +
        `detector is broken; a scanner reporting no findings after checking nothing is ` +
        `the failure this assertion exists to catch.`
    );

    assert.equal(
      result.findings.length,
      0,
      `${detector.id} found ${result.findings.length}:\n` +
        result.findings.map((f) => `  ${f.where}\n    ${f.what}`).join("\n")
    );
  });
}

test("every detector in the directory is claimed by the register", () => {
  // A detector nobody records is a detector that gets deleted in a tidy-up,
  // because nothing says which defect it was written for.
  const claimed = new Set(
    CLASSES.filter((c) => c.coverage.kind === "detector").map((c) => c.coverage.name)
  );
  for (const detector of detectors) {
    assert.ok(
      claimed.has(detector.id),
      `${detector.id} exists but no register entry names it. Add the class it catches.`
    );
  }
});

test("a class that has recurred is caught by something, or says why it cannot be", () => {
  const unresolved = [];

  for (const cls of CLASSES) {
    if (cls.instances < COVERAGE_REQUIRED_AT) continue;
    if (cls.coverage.kind !== "none") continue;
    if (typeof cls.coverage.whyUncoverable === "string" && cls.coverage.whyUncoverable.trim().length > 40) {
      continue;
    }
    unresolved.push(cls);
  }

  assert.equal(
    unresolved.length,
    0,
    "These have recurred " +
      COVERAGE_REQUIRED_AT +
      " times or more with nothing catching them and no reason recorded:\n" +
      unresolved.map((c) => `  ${c.id} — ${c.instances} instances`).join("\n") +
      "\n\nWrite a detector, name an existing test or gate, or write whyUncoverable. " +
      "Leaving it blank is the state this register was built to end."
  );
});

test("a detector named by the register actually exists", () => {
  const present = new Set(detectors.map((d) => d.id));
  for (const cls of CLASSES) {
    if (cls.coverage.kind !== "detector") continue;
    assert.ok(
      present.has(cls.coverage.name),
      `${cls.id} claims detector "${cls.coverage.name}", which is not in scripts/recurrence/detectors. ` +
        `A register that claims coverage it does not have is worse than one that admits the gap.`
    );
  }
});

test("every class carries evidence rather than a recollection", () => {
  for (const cls of CLASSES) {
    assert.ok(cls.evidence?.length > 0, `${cls.id} records no evidence at all`);
    for (const item of cls.evidence) {
      assert.ok(
        typeof item.note === "string" && item.note.length > 10,
        `${cls.id} has an evidence entry with no note`
      );
      // A sha is optional -- several of these classes were recorded in a file
      // header rather than a commit, and demanding one would have meant either
      // omitting them or inventing it.
      if (item.sha !== null) {
        assert.match(item.sha, /^[0-9a-f]{7,40}$/, `${cls.id} has an evidence sha that is not one`);
      }
    }
  }
});
