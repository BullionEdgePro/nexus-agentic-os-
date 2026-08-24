/**
 * A test that searches source for a marker the source no longer contains.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * `indexOf` does not throw. It returns -1, and -1 is a perfectly good number to
 * carry on with. Two things then happen, both silent:
 *
 *   SLICE. `SRC.slice(SRC.indexOf("function foo"))` becomes `slice(-1)` — the
 *   last character of the file. Every assertion made about that "function body"
 *   is now made about one character, and every `!body.includes(...)` in it
 *   passes for free.
 *
 *   COMPARE. `SRC.indexOf(a) < SRC.indexOf(b)` is how this repository asserts
 *   that one call happens before another. When `a` is missing the comparison is
 *   `-1 < something`, which is TRUE. The ordering property is not merely
 *   unchecked — the test actively reports that it holds.
 *
 * 244 distinct markers are searched for across these tests and 198 of them bound
 * a slice. Ten guard against -1.
 *
 * This is not hypothetical, and the first instance was found by the first run:
 *
 *   handover-brief.test.mjs asserted that the AI is paused BEFORE the handover
 *   summary is built — "ordering is the whole safety property", says its own
 *   comment, because a slow model must not delay the pause. It searched for
 *   `await setConversationHandoff(conversationId, true)`. That call gained a
 *   required `reason` argument in ae0ec7024, so the marker stopped matching, and
 *   the assertion became `-1 < 20538`. It would now pass with the handoff after
 *   the brief, or with the handoff deleted. 1034 tests stayed green.
 *
 * It is the same failure family as a-claim-satisfied-by-prose — a source-scanning
 * test that goes green without checking anything — reaching the assertions that
 * one cannot see, the ones made on an extracted body rather than the whole file.
 *
 * ============================================================
 * WHAT IT ACTUALLY DOES
 * ============================================================
 *
 * For every `IDENT.indexOf("marker")` where IDENT holds a whole source file, it
 * reads that file and asks whether the marker is there. A missing marker is a
 * finding: whatever the test does with that -1, it is not what the test says it
 * is doing.
 *
 * It deliberately does not judge the arithmetic afterwards. Slice, compare or
 * both, the answer is the same — the search failed, so the test is not testing
 * what it claims.
 */
import { lineAt, read, relative } from "../source.mjs";
import { IDENT, testFiles, unescape, wholeFileBindings } from "../test-bindings.mjs";

export const id = "an-extraction-that-found-nothing";

export function detect() {
  const findings = [];
  const unchecked = [];
  let checked = 0;
  const targets = new Map();

  for (const testFile of testFiles()) {
    const src = read(testFile);
    const { bound, unchecked: skipped } = wholeFileBindings(testFile, src);
    for (const s of skipped) unchecked.push({ where: relative(testFile), ...s });

    for (const [name, target] of bound) {
      const re = new RegExp(
        `(?<![\\w$.])${name}\\s*\\.indexOf\\(\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1\\s*\\)`,
        "g"
      );
      for (const m of src.matchAll(re)) {
        // A template literal with a substitution in it has no value until the
        // test runs, and this cannot know what `${fn}` will be. Skipping it is
        // the difference between a detector worth reading and one that is not:
        // the first run of this reported seven findings, and six were markers
        // like "export async function ${fn}" looped over a list of real
        // function names. Six false alarms out of seven teaches people to
        // ignore the seventh, which was the live defect.
        if (m[2].includes("${")) {
          unchecked.push({
            where: relative(testFile),
            name,
            why: "the marker is a template literal whose value is only known at run time",
          });
          continue;
        }
        const marker = unescape(m[2]);
        if (marker === "") continue;
        checked++;
        if (!targets.has(target)) targets.set(target, read(target));
        if (targets.get(target).includes(marker)) continue;

        findings.push({
          where: `${relative(testFile)}:${lineAt(src, m.index)}`,
          what:
            `searches ${relative(target)} for ${JSON.stringify(
              marker.length > 60 ? `${marker.slice(0, 60)}...` : marker
            )}, which is NOT THERE. ` +
            `indexOf returns -1 and the test carries on with it: a slice becomes the last ` +
            `character of the file, and an ordering comparison becomes trivially true.`,
        });
      }
    }
  }

  return { findings, checked, unchecked };
}
