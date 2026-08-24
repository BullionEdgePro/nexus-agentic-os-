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
 *   runtime-gate  one of the eleven gates in verify-all.sh, run against production
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
        "TWO THINGS COVER THIS, and an earlier version of this entry named only the first, " +
        "which understated the coverage and — worse — pointed the next reader at work " +
        "already done. " +
        "(1) shared-number-check probes each known call site twice, scoped to the business " +
        "and then through the reply path's real shape, and compares. It cannot see a call " +
        "site nobody has added to it, which is how the tenth and eleventh instances happened " +
        "after it existed. " +
        "(2) every-agent-read-widens-itself.test.mjs is the SOURCE-LEVEL half, and the " +
        "stronger of " +
        "the two: every exported reader in @nexus/db that the agent packages can reach and " +
        "that filters on organization_id must widen AT THE READ rather than trust its " +
        "callers. Exemptions are a written list with a stated reason each, and it is " +
        "mutation-tested — the scan is re-run with the widening textually removed and must " +
        "find the readers again. " +
        "WHAT NEITHER SEES is a query written inline outside packages/db, which is exactly " +
        "where the eleventh instance was: getPool().query in bi-copilot.ts, not a db reader " +
        "at all. Measured 2026-08-24: eight such files outside packages/db. Four widen. The " +
        "other four — knowledge ingest and manage, lead capture, and the operator sweep — " +
        "were checked one by one and NONE IS ON THE CUSTOMER REPLY PATH, which is the only " +
        "place the owner/serving mismatch arises; the nearest, ingestUrlSet, is reached by " +
        "the reindex job, which does not run in a number owner's transaction. So the gap is " +
        "real and currently empty. A detector for it would today scan two files that already " +
        "widen, which is why there is not one.",
    },
  },

  {
    id: "an-error-collapsed-into-a-value-that-reads-as-a-fact",
    signals: ["catch(() =>", "fail open", "fail closed", "could not check", "reads as a fact"],
    title: "A caught error becoming a value indistinguishable from a real answer",
    mechanism:
      "`.catch(() => null)`, `.catch(() => [])`, `.catch(() => 0)`. The failure stops being a " +
      "failure and becomes a FACT: nothing found, nobody waiting, nothing owed, no queue " +
      "failing. Nothing downstream can tell it from the real thing, and the screen or the " +
      "reply states it with the same confidence either way. This is the same confusion as " +
      "the eleven-instance RLS class one layer up — there, zero rows meant 'this business " +
      "has nothing configured'; here, a caught error means it.",
    instances: 3,
    evidence: [
      {
        sha: null,
        note:
          "the reply path's sticky routing: findOrganizationById(...).catch(() => null) made " +
          "a transient database error identical to 'this business is gone', so one hiccup " +
          "re-triaged a live conversation onto whichever business the customer's next " +
          "sentence mentioned — and logged 'no longer active', a cause it could not know",
      },
      {
        sha: null,
        note:
          "/health/jobs: readQueueHealth(...).catch(() => []) emptied `failing` and " +
          "`backedUp`, so a Redis outage — the one fault that stops every queue at once — " +
          "answered a monitor with ok:true",
      },
      {
        sha: null,
        note:
          "the handover brief: listOpenTasksForConversation(...).catch(() => []) rendered as " +
          "no outstanding promises, on the one lookup its own comment says is fetched first " +
          "so commitments survive every other failure",
      },
    ],
    coverage: {
      kind: "none",
      whyUncoverable:
        "The deliberate ones and the defects are TEXTUALLY IDENTICAL. A sweep on 2026-08-24 " +
        "found twelve of these on the paths that matter and nine were correct, each with the " +
        "direction argued in place: hasStaffOnShift().catch(() => true) assumes somebody IS " +
        "there, because a database blip must not make five agents start telling customers " +
        "nobody can help them. What separates a decision from a defect is whether the " +
        "fallback is later PRESENTED AS A FACT, and no scanner can see that. " +
        "THE RECIPE: when the fallback value would be indistinguishable from a real answer, " +
        "carry a second field saying which it was, and surface it where the reader is — " +
        "`queuesUnreadable` in the health JSON, `followUpsUnavailable` rendered as 'this is " +
        "not the same as none', `lookupFailed` deciding a branch. Deciding a direction is " +
        "not enough on its own; the direction has to be legible to whoever acts on it.",
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
    instances: 5,
    evidence: [
      { sha: null, note: "a migration whose failure `| tail -3` hid; DEPLOY.md warns about it" },
      { sha: "8079a35a2", note: "three times in one day, by the author of two of the warnings" },
      { sha: "6ee31a56f", note: "the pre-commit hook exists because of that day" },
      {
        sha: null,
        note:
          "and a fifth on 2026-08-24, within an hour of this detector shipping: npm test " +
          "piped to grep, grep found the word fail, and && committed a red suite",
      },
    ],
    coverage: {
      kind: "detector",
      name: "a-pipeline-that-swallows-its-failure",
      note:
        "Every script here sets pipefail today, held up by whoever last remembered. A " +
        "convention that has already failed four times is not a control. It cannot see a " +
        "command typed at a prompt, which is where all five instances actually happened. " +
        "Two things now attack that half. scripts/check.sh prints four lines and its own " +
        "exit code, so there is no reason left to pipe npm test at all -- the same fix " +
        "verify-all.sh made for the eleven-command verification: MAKE THE RIGHT THING THE " +
        "SHORT THING. And the pre-commit hook now fires on .sh too, which is precisely what " +
        "it did not do on the day the fifth instance got through.",
    },
  },

  {
    id: "a-gate-that-passes-on-the-wrong-thing",
    signals: ["fire check", "dry run", "gate was wrong", "somebody else's finding", "self-check"],
    title: "A gate whose verdict comes from something other than the property it names",
    mechanism:
      "A gate that fails loudly is easy. A gate that answers a NEARBY question is not: it " +
      "reports on the wrong row, on its own leftover fixture, or on a shape the real system " +
      "never produces — and it says PASS or FAIL with the same confidence either way. Every " +
      "instance here was found by reading the gate, never by the gate.",
    instances: 5,
    evidence: [
      { sha: "e1b369d93", note: "operator-fire-check was green on a finding its seed had not caused" },
      { sha: "dbb0ab053", note: "and then asserted on whichever finding came back first" },
      { sha: "08d6fe386", note: "the dry run answered for an agent told less than the real one" },
      {
        sha: "6effc4cc7",
        note:
          "self-check reported DOUBLE BOOKED for a booking that went to a second free person " +
          "— its own probe employee, created by the section above it. It asserted the slot " +
          "cannot be taken twice; the guarantee is that a PERSON cannot be. It also only " +
          "failed on some weekdays, the probe slot being 96 hours out",
      },
      {
        sha: null,
        note:
          "fifth the next day, in the check written to verify the fix for the fourth: it " +
          "asserted booking is offered IF AND ONLY IF somebody is on a rota, and failed a " +
          "shop that sells things and correctly offers none. An implication, not an equivalence",
      },
    ],
    coverage: {
      kind: "none",
      whyUncoverable:
        "Whether an assertion is about the right thing is a semantic question, and nothing " +
        "in a scanner can answer it — the code is well-formed, the assertion runs, and both " +
        "the true and the false version compile and pass. What DOES work is cheap and is " +
        "written down here because it resolved the fourth instance in a single run: make " +
        "the failure message carry the evidence rather than the verdict. 'DOUBLE BOOKED' " +
        "cost a day of guessing; '2 bookings hold that slot: Ralph Ivan Simeon, Self Check " +
        "Bookable' named the cause in one line, and it was the gate's own fixture. A gate " +
        "that states what it saw can be argued with. One that states only its conclusion " +
        "cannot.",
    },
  },

  {
    id: "an-assertion-over-a-hand-written-population",
    signals: ["hard-coded", "every reachable", "population", "derived", "by name"],
    title: 'A test that says "every X" while iterating a list somebody typed',
    mechanism:
      "The assertion is right and the population is hand-written, so the test is true of the " +
      "members somebody had already thought about and silent about the one added tomorrow. It " +
      "reads as broad coverage and is narrow coverage, and unlike a wrong assertion it never " +
      "goes red to say so.",
    instances: 3,
    evidence: [
      {
        sha: null,
        note:
          "login-can-be-guessed-forever read admin-auth.ts and employee-auth.ts BY NAME. A " +
          "third route checking a secret would have been unthrottled and left it green",
      },
      {
        sha: null,
        note:
          "what-is-running-is-what-is-committed asserted the gate list had exactly ten " +
          "entries, which could only ever catch somebody ADDING a gate — the safe change — " +
          "while a typo in the list passed and failed at 3am with 'no such file'",
      },
      {
        sha: null,
        note:
          'a-blank-page-is-the-worst-answer said "every reachable area has a boundary" and ' +
          "iterated four paths. Its wording also implied four areas were at fault that were " +
          "not, so the list and the sentence quietly disagreed",
      },
    ],
    coverage: {
      kind: "none",
      whyUncoverable:
        "A literal list is not a defect. Most of the 1051 tests here iterate one and are " +
        "right to — a detector would have to know that a particular list SHOULD have been " +
        "derived, which is a judgement about intent, and it would flag hundreds of correct " +
        "tests to find the next one of these. " +
        "THE RECIPE IS THE MITIGATION, and all three fixes used it unchanged: derive the " +
        "population from whatever actually defines it — the filesystem, the router mounts, " +
        "the middleware list — then assert the derived set is non-empty AND still contains " +
        "the members you expected. The second half is what makes it safe: a derivation that " +
        "silently returns nothing is the vacuous-loop failure wearing a better coat, and " +
        "this repository has shipped that one too.",
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
    instances: 8,
    evidence: [
      {
        sha: null,
        note:
          "the eighth, 2026-08-24, is a NEW SHAPE and the detector grew to match it: the " +
          "escape survived into the file and became a control character only at RUN TIME. " +
          "Inside a template literal a lone backslash-b is the backspace escape, so a regex " +
          "built that way was handed 0x08 and matched no queue name at all -- while the test " +
          "said every queue this platform runs is watched",
      },
      {
        sha: null,
        note:
          "the seventh, 2026-08-24, in a route-authorisation checker: a pattern built with " +
          "new RegExp and a template literal arrived with its parenthesis unescaped and its " +
          "newlines literal. Rewritten with plain string operations and no regex at all, " +
          "which is the only mitigation that has never failed",
      },
      {
        sha: null,
        note:
          "the sixth, 2026-08-24, is the one that changed this entry: a regex written with " +
          "backslash-b arrived as the BYTE 0x08, so it required a backspace character, matched " +
          "nothing, and its negated assertion passed for ever. Two live instances were found " +
          "by scanning for it -- the register's own honesty check, and the guard against an " +
          "unguarded tenant cast in an RLS policy, which had never once run",
      },
      {
        sha: null,
        note:
          "recurring across sessions; three times in this one -- it is how the detector's own path resolution came to be three levels too deep, and it later turned a newline escape in a console.log into a literal line break that only the workspace typecheck caught. Not confined to regexes: ANY escape " +
          "detector's own path resolution came to be three levels too deep",
      },
    ],
    coverage: {
      kind: "detector",
      name: "a-control-character-in-source",
      note:
        "HALF THE CLASS, and the half that matters. This entry said `none` and gave a reason, " +
        "which was true of the damage that leaves valid-looking source: \s collapsing to s " +
        "produces a working regex that is merely wrong, and no scanner can know it was not " +
        "intended. But when the eaten escape was \b, \f, \v or \0 the result is a BYTE with " +
        "no business in source, which cannot be typed by accident and is trivial to find. It " +
        "is also the more dangerous half: a mangled character class usually breaks loudly, " +
        "while a control character silently makes a pattern unmatchable and every assertion " +
        "built on it green. Its first run found two, both years-of-green-tests shaped. What " +
        "remains uncoverable is the quiet collapse, and the mitigation for that is unchanged: " +
        "write escape-bearing files with a tool that does not re-escape, and read back what " +
        "landed.",
    },
  },
];
