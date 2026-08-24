/**
 * A test that requires something of the source, and is satisfied by a comment.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * 88 test files in this repository read source text and assert against it. That
 * is the only way several of this project's rules can be checked at all — "the
 * reply path must call withServingTenant", "this decision must not be invisible",
 * "no invented figure survives into rendered code" are properties of the code as
 * written, not of any value it computes.
 *
 * The technique has one failure mode and it is silent. `assert.ok(
 * SRC.includes("withServingTenant"))` passes when the file merely MENTIONS
 * withServingTenant — in the paragraph explaining why it is needed, in a `//
 * TODO: use withServingTenant here`, in the very comment somebody wrote while
 * deciding not to do it. The test is green. The code does not do the thing. And
 * because prose in this repository is dense and deliberate, the phrase a test
 * bans or requires is exactly the phrase the surrounding comment is most likely
 * to contain.
 *
 * The inverse has already happened three times here and cost a cycle each time:
 * an assertion banning a phrase matched the COMMENT explaining why the phrase is
 * banned, and the test went red for a reason that had nothing to do with the
 * code. That direction is loud — a red test gets looked at. This one is not.
 * Three of the ten tests that strip comments today say in their own words that
 * they learned it the hard way.
 *
 * ============================================================
 * WHAT IT ACTUALLY DOES
 * ============================================================
 *
 * For every `IDENT.includes("phrase")` assertion made against a binding that
 * holds a whole source file verbatim, it reads that file, removes the comments,
 * and asks whether the phrase is still there. If the phrase survives only in
 * prose, the assertion is green on prose and the finding names it.
 *
 * WHAT IT DOES NOT CHECK, it says out loud. A binding that has been sliced,
 * matched or replaced before the assertion — a function body extracted, comments
 * already stripped — is not a whole file, so this cannot reason about it and
 * does not pretend to. Nor can it read `doesNotMatch` regexes. Those are counted
 * and reported, because a scanner that stays quiet about its blind spots reports
 * a clean tree and means "I checked the easy half".
 *
 * `an-extraction-that-found-nothing` covers part of that blind spot from the
 * other side: it cannot see what an extracted body contains either, but it can
 * see when the extraction found nothing at all.
 */
import { commentsOf, lineAt, read, relative, withoutComments } from "../source.mjs";
import { IDENT, testFiles, unescape, wholeFileBindings } from "../test-bindings.mjs";

export const id = "a-claim-satisfied-by-prose";

export function detect() {
  const findings = [];
  const unchecked = [];
  let checked = 0;

  const cache = new Map();
  const load = (path) => {
    if (!cache.has(path)) {
      const raw = read(path);
      cache.set(path, { code: withoutComments(raw), comments: commentsOf(raw) });
    }
    return cache.get(path);
  };

  for (const testFile of testFiles()) {
    const src = read(testFile);
    const { bound, unchecked: skipped } = wholeFileBindings(testFile, src);
    for (const s of skipped) unchecked.push({ where: relative(testFile), ...s });

    for (const [name, target] of bound) {
      // Positive assertions only. A `!X.includes(...)` matched by a comment
      // makes the test red, and a red test is already being looked at; this is
      // for the direction nobody is looking at.
      const re = new RegExp(
        `(?<![!\\w$.])${name}\\s*\\.includes\\(\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1\\s*\\)`,
        "g"
      );
      for (const m of src.matchAll(re)) {
        if (m[2].includes("${")) {
          unchecked.push({
            where: relative(testFile),
            name,
            why: "the phrase is a template literal whose value is only known at run time",
          });
          continue;
        }
        const phrase = unescape(m[2]);
        if (phrase.trim() === "") continue;
        checked++;

        const { code, comments } = load(target);
        if (!comments.includes(phrase)) continue; // never in prose; nothing to confuse
        if (code.includes(phrase)) continue; // in the code too, so the claim stands on code

        findings.push({
          where: `${relative(testFile)}:${lineAt(src, m.index)}`,
          what:
            `requires ${JSON.stringify(phrase)} of ${relative(target)}, and that phrase exists ` +
            `there ONLY IN A COMMENT. The assertion is green on prose.`,
        });
      }
    }
  }

  return { findings, checked, unchecked };
}

export { IDENT };
