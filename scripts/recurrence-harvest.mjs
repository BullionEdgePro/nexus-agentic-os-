#!/usr/bin/env node
/**
 * Read this project's own history and say where the register has fallen behind.
 *
 *   node scripts/recurrence-harvest.mjs
 *   node scripts/recurrence-harvest.mjs --since 2026-08-01
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * A register nobody re-measures becomes ARCHITECTURE-ABOS.md, which sat for
 * weeks saying sixteen operators when there were twenty and six copilot
 * questions when there were ten. Every count in a hand-maintained document
 * decays, and the decay is invisible because the document reads exactly as
 * confidently when it is wrong.
 *
 * The history here is unusually good raw material. Commit messages in this
 * project name the mechanism and count the repetitions out loud — "Nine
 * instances of one defect", "the eleventh, in code I wrote an hour ago", "for
 * the same reason I have warned about twice today". That is a defect record
 * already written; it has simply never been read by anything.
 *
 * ============================================================
 * IT PROPOSES, IT DOES NOT WRITE
 * ============================================================
 *
 * Deliberately, and for the same reason the procedure inference proposes and
 * never activates: deciding that two commits describe THE SAME defect class is a
 * judgement, and a substring match is not qualified to make it. A harvester that
 * edited the register would quietly inflate counts on any commit that happened
 * to use the word "backslash", and the register's value is entirely in being
 * trustworthy.
 *
 * So it prints what it found and what it would change. A person decides.
 */
import { execFileSync } from "node:child_process";
import { CLASSES } from "./recurrence/register.mjs";
import { REPO_ROOT } from "./recurrence/source.mjs";

const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;

// Printable markers rather than NUL. execFile refuses an argument containing a
// null byte, so the obvious %x00 separator cannot reach git through this API at
// all -- and commit bodies here carry every kind of punctuation, so the
// separator has to be something no prose would produce.
const FIELD = "<|F|>";
const RECORD = "<|R|>";

function commits() {
  const format = ["%h", "%ad", "%s", "%b"].join(FIELD) + RECORD;
  const argv = ["log", "--format=" + format, "--date=short"];
  if (since) argv.push("--since=" + since);
  argv.push("--", ".");
  const out = execFileSync("git", argv, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split(RECORD)
    .map((chunk) => chunk.split(FIELD))
    .filter((parts) => parts.length >= 3 && parts[0].trim())
    .map(([sha, date, subject, body]) => ({
      sha: sha.trim(),
      date: date.trim(),
      subject: subject.trim(),
      text: (subject + String.fromCharCode(10) + (body || "")).toLowerCase(),
    }));
}

/** The words this project uses when it is admitting a repetition. */
const ORDINALS = [
  "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth",
  "ninth", "tenth", "eleventh", "twelfth", "thirteenth",
];
const RECURRENCE = new RegExp(`\\b(${ORDINALS.join("|")})\\b\\s+(instance|time)`, "i");

const log = commits();
console.log(`RECURRENCE HARVEST — ${log.length} commits read${since ? ` since ${since}` : ""}\n`);

// ---- where the register's counts stand against the history -----------------
console.log("CLASSES");
const claimed = new Set();
let behind = 0;

for (const cls of CLASSES) {
  const hits = log.filter((c) => cls.signals.some((s) => c.text.includes(s)));
  for (const hit of hits) claimed.add(hit.sha);

  const admissions = hits.filter((c) => RECURRENCE.test(c.text));
  const latest = hits[0]?.date ?? "never";

  // The commit count is NOT the instance count and is not reported as one. One
  // defect can take three commits and one commit can fix two defects; the
  // number below is how much material exists, not a verdict on it.
  const flag = admissions.length > 0 ? "  <- commits here admit a repetition" : "";
  console.log(
    `  ${cls.id}\n` +
      `      register: ${String(cls.instances).padStart(2)} instances, coverage ${cls.coverage.kind}\n` +
      `      history:  ${String(hits.length).padStart(2)} commits mention it, most recent ${latest}${flag}`
  );
  if (admissions.length > 0) {
    behind++;
    for (const a of admissions.slice(0, 3)) console.log(`        ${a.sha} ${a.date} ${a.subject}`);
  }
}

// ---- repetitions the register does not claim at all ------------------------
const unclaimed = log.filter((c) => RECURRENCE.test(c.text) && !claimed.has(c.sha));

console.log("\nUNCLAIMED REPETITIONS");
if (unclaimed.length === 0) {
  console.log("  none — every commit admitting a repetition matches a registered class.");
} else {
  console.log(
    `  ${unclaimed.length} commit(s) say a mistake repeated, and no class in the register\n` +
      "  claims them. Each is either a class that belongs here or a signal that needs widening:\n"
  );
  for (const c of unclaimed.slice(0, 15)) console.log(`    ${c.sha} ${c.date} ${c.subject}`);
}

console.log(
  "\n" +
    (behind + unclaimed.length === 0
      ? "Nothing to reconcile: the register matches what the history admits.\n"
      : `${behind} registered class(es) have commits admitting a repetition, and ` +
        `${unclaimed.length} commit(s)\nadmit one that no class claims.\n`) +
    "\nNothing has been written. Edit scripts/recurrence/register.mjs if any of the above\n" +
    "is a real repetition — and if you raise a count to " +
    "3 or more, the suite will require\ncoverage or a written reason before it goes green again."
);
