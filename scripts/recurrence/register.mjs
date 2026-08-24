/**
 * The mistakes this project has made more than once, and what now catches them.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * This repository is unusually good at recording its own defects. 343 commits,
 * and the messages are not "fix bug" — they name the mechanism, count the
 * repetitions, and say what it cost. "Nine instances of one defect, and now a
 * check instead of a tenth." "I shipped with three red tests, for the same
 * reason I have warned about twice today." "The eleventh instance, in code I
 * wrote an hour ago."
 *
 * And then nothing reads any of it. The count lives in prose, in a commit
 * message nobody opens again, and the next person — or the next session of the
 * same person — starts from zero. Three separate files warn in their headers
 * about pipelines swallowing exit codes; the mistake was made three times in one
 * day BY SOMEBODY WHO HAD WRITTEN TWO OF THOSE WARNINGS. That is not a lapse of
 * attention. It is what happens when the only place a lesson is stored is a
 * paragraph, and the fix belongs in the repository rather than in anybody's
 * memory.
 *
 * So this file is the memory, and `the-same-mistake-twice.test.mjs` is the
 * teeth. A class that has recurred three times must have something that catches
 * it, or an explicit written reason why nothing can. Anything else fails the
 * suite until somebody resolves it — which is the whole loop:
 *
 *     a defect is found  ->  recorded here with its evidence
 *                        ->  a detector is written, or the impossibility stated
 *                        ->  the gate enforces it
 *                        ->  the next instance is caught before it ships
 *
 * `recurrence-harvest.mjs` closes it: it re-reads the git history and reports
 * where these counts have fallen behind what the log actually says. It proposes
 * and never writes, for the same reason the procedure inference proposes and
 * never activates.
 *
 * ============================================================
 * WHAT COUNTS AS COVERAGE
 * ============================================================
 *
 *   detector      a scanner in this directory, run by the gate on every commit
 *   runtime-gate  one of the ten gates in verify-all.sh, run against production
 *   test          an ordinary test that happens to close the class
 *   compiler      the build genuinely cannot produce the defect
 *   none          nothing catches it. Allowed ONLY with `whyUncoverable`
 *
 * `whyUncoverable` is not an escape hatch to be filled in with "hard". It is for
 * classes whose artifact does not exist in this repository — a mistake made at a
 * shell prompt leaves nothing here to scan. Writing one is a claim that will be
 * read by whoever hits the class next.
 */

/** A class must be caught by the third instance. Two is a coincidence; three is a pattern. */
export const COVERAGE_REQUIRED_AT = 3;

export const CLASSES = [
  {
    id: "a-read-for-the-serving-business-from-the-owners-transaction",
    signals: ["serving business", "shared number", "routed_organization_id", "withservingtenant", "number's owner"],
    title: "A read for the SERVING business, made inside the NUMBER OWNER's transaction",
    mechanism:
      "Migration 010 put all five businesses on Zipicka's WhatsApp number. Every inbound " +
      "message runs in a transaction scoped to the number's OWNER, while the thing being " +
      "read belongs to the SERVING business. Under RLS that is not an error. It is zero " +
      "rows, which every caller correctly reads as 'this business has nothing configured'.",
    instances: 11,
    evidence: [
      { sha: "cb2f7ffae", note: "nine instances, and a gate written instead of a tenth" },
      { sha: "3fac2b01c", note: "a firm serving a conversation could not answer its own customer" },
      { sha: "a92174359", note: "the eleventh, in code written an hour earlier that day" },
      { sha: "d0f2b638a", note: "and one that was NOT an instance — a misread probe, reverted" },
    ],
    coverage: {
      kind: "runtime-gate",
      name: "shared-number-check",
      note:
        "Probes each known call site twice — scoped to the business, then through the reply " +
        "path's real shape — and compares. It cannot see a call site nobody has added to it, " +
        "which is how the tenth and eleventh instances still happened after it existed.",
    },
  },

  {
    id: "a-claim-satisfied-by-prose",
    signals: ["matched the comment", "own doc comment", "comments stripped", "satisfied by prose"],
    title: "An assertion about source text, decided by a comment rather than by code",
    mechanism:
      "88 test files here assert against source text, because several of this project's " +
      "rules are properties of the code as written. Comments are part of that text. A " +
      "required phrase found only in the paragraph explaining why it is required makes the " +
      "test green while the code does nothing, and this repository's prose is dense enough " +
      "that the phrase a test names is exactly the phrase its comments contain.",
    instances: 3,
    evidence: [
      { sha: "21443d522", note: "an assertion matched the COMMENT explaining the rule it enforced" },
      {
        sha: null,
        note:
          "two more of the same shape; three of the ten tests that strip comments today say " +
          "in their own words that they learned it by being bitten",
      },
    ],
    coverage: {
      kind: "detector",
      name: "a-claim-satisfied-by-prose",
      note:
        "Covers the SILENT direction — a requirement satisfied by prose. Proven by deleting " +
        "the tenant scoping from the inbox query and leaving the requirement in a comment: " +
        "all 15 tests in two files stayed green, and the detector named both. The loud " +
        "direction, a ban matched by prose, needs no detector because it turns a test red.",
    },
  },

  {
    id: "an-extraction-that-found-nothing",
    signals: ["indexof", "extraction", "marker", "vacuous", "tautolog"],
    title: "A test searching source for a marker the source no longer contains",
    mechanism:
      "indexOf does not throw. It returns -1, and -1 is a perfectly good number to carry " +
      "on with. A slice bounded by it becomes the LAST CHARACTER of the file, so every " +
      "assertion about that 'function body' passes for free; and an ordering comparison " +
      "becomes `-1 < something`, which is TRUE — the property is not merely unchecked, the " +
      "test actively reports that it holds.",
    instances: 3,
    evidence: [
      {
        sha: "ae0ec7024",
        note:
          "setConversationHandoff gained a required reason argument, so handover-brief's " +
          "ordering assertion — 'ordering is the whole safety property', says its own " +
          "comment — became -1 < 20538 and would have passed with the handoff deleted",
      },
      {
        sha: null,
        note:
          "244 distinct markers are searched across these tests; 198 bound a slice and ten " +
          "guard against -1. The class is the shape of the technique, not one mistake",
      },
      {
        sha: null,
        note:
          "same family as a-claim-satisfied-by-prose: a source-scanning test that goes green " +
          "without checking anything, which has now happened in both of its two forms",
      },
    ],
    coverage: {
      kind: "detector",
      name: "an-extraction-that-found-nothing",
      note:
        "Checks 252 markers against the files they are searched in. It skips markers built " +
        "from template literals, whose value is only known at run time — its first version " +
        "did not, and reported seven findings of which six were false. Six false alarms out " +
        "of seven teaches people to ignore the seventh, which was the live defect.",
    },
  },

  {
    id: "a-pipeline-that-swallows-its-failure",
    signals: ["pipefail", "swallow", "exit code", "red tests", "| grep"],
    title: "A pipeline's exit status read without pipefail, reporting a failure as success",
    mechanism:
      "Without `set -o pipefail` a pipeline exits with its LAST command's status. " +
      "`npm test | grep fail` succeeds exactly when the tests failed, and `... | tail -3; " +
      "echo $?` prints tail's zero over a migration that did not run.",
    instances: 4,
    evidence: [
      { sha: null, note: "a migration whose failure `| tail -3` hid; DEPLOY.md warns about it" },
      { sha: "8079a35a2", note: "three times in one day, by the author of two of the warnings" },
      { sha: "6ee31a56f", note: "the pre-commit hook exists because of that day" },
    ],
    coverage: {
      kind: "detector",
      name: "a-pipeline-that-swallows-its-failure",
      note:
        "Every script here sets pipefail today, held up by whoever last remembered. A " +
        "convention that has already failed four times is not a control. It cannot see a " +
        "command typed at a prompt, which is where all four instances actually happened.",
    },
  },

  {
    id: "a-css-token-that-does-not-exist",
    signals: ["does not exist renders as nothing", "custom property", "var(--", "css token"],
    title: "A `var(--token)` naming a custom property nothing defines",
    mechanism:
      "An undefined custom property is not an error. It renders as nothing, and nothing " +
      "usually looks like a deliberately unstyled element. `--ink-1` and `--ink-3` were " +
      "referenced by six declarations and had never existed.",
    instances: 6,
    evidence: [{ sha: "2a0d93813", note: "six declarations, dead since the day they shipped" }],
    coverage: {
      kind: "test",
      name: "apps/api/test/a-token-that-does-not-exist-renders-as-nothing.test.mjs",
      note: "Collects every defined property and every reference, and diffs them.",
    },
  },

  {
    id: "a-backtick-inside-a-sql-template-literal",
    signals: ["backtick", "template literal"],
    title: "A backtick written inside SQL that is itself a template literal",
    mechanism:
      "The SQL in this repository lives in template literals. A backtick used for emphasis " +
      "in a SQL comment terminates the literal, and everything after it is parsed as code.",
    instances: 5,
    evidence: [
      {
        sha: null,
        note:
          "four times in SQL, plus once more while building this loop — an inline `node -e` " +
          "probe, killed by the same character for the same reason",
      },
    ],
    coverage: {
      kind: "compiler",
      name: "tsc / node",
      note:
        "A syntax error, caught within seconds every time, which is why five instances have " +
        "cost almost nothing. Recorded because a class that recurs five times and is cheap " +
        "is worth telling apart from one that recurs five times and is not.",
    },
  },

  {
    id: "a-heredoc-that-eats-a-backslash",
    signals: ["heredoc", "backslash", "escaping level"],
    title: "A quoted heredoc stripping one level of escaping from regex-bearing code",
    mechanism:
      "Writing a file through a quoted heredoc removes one backslash level. Regexes arrive " +
      "with `\\s` collapsed to `s` and `\\1` collapsed to a literal control character. The " +
      "file is written successfully and the program is silently wrong.",
    instances: 4,
    evidence: [
      {
        sha: null,
        note:
          "recurring across sessions; twice while building this loop, which is how the " +
          "detector's own path resolution came to be three levels too deep",
      },
    ],
    coverage: {
      kind: "none",
      whyUncoverable:
        "The defect is in the transport between an editing tool and the disk, not in " +
        "anything this repository contains. By the time a file exists to scan, the damage " +
        "is indistinguishable from a typo — and the tree is scanned by node, which reports " +
        "the resulting regex as invalid or, worse, accepts it. The mitigation is not a " +
        "detector: write regex-bearing files with a tool that does not re-escape, and read " +
        "back what landed.",
    },
  },
];
