/**
 * The backup said it every night, into a file nobody opened.
 *
 * ============================================================
 * WHAT WAS MEASURED
 * ============================================================
 *
 * On 2026-08-27, on production: rclone installed, /etc/nexus-backup.env
 * present, and BACKUP_REMOTE and BACKUP_PASSPHRASE both EMPTY. Somebody began
 * setting the off-box copy up and did not finish. Every night since, the run
 * has printed
 *
 *   "Off-box copy: SKIPPED. BACKUP_REMOTE is not set, so this dump exists only
 *    on this machine, beside the database it is protecting."
 *
 * into /var/log/nexus-backup.log, and nothing else has ever mentioned it.
 *
 * `backup-check.sh` reads the same files and is one of the twelve gates. It
 * REPORTS the off-box state rather than failing on it, for a reason it argues
 * in its own header — a gate that is red until somebody buys storage is a gate
 * people stop reading — and it names the hole it leaves open:
 *
 *   "It closes the hole where nothing COULD notice, not the hole where nobody
 *    is looking."
 *
 * An operator is the right shape for that hole where a gate was not, and the
 * difference is the dismissal horizon: a finding can be acknowledged for a day,
 * a week or a month and then comes BACK. A permanently-red gate cannot be
 * acknowledged, only ignored.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { operatorBody } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const SCRIPT = read("scripts", "backup-db.sh");
const MIGRATION = readdirSync(join(root, "packages", "db", "migrations"))
  .filter((f) => f.startsWith("070-"))
  .map((f) => read("packages", "db", "migrations", f))
  .join("\n");

const BODY = operatorBody(OPERATORS, "backup-unprotected");

test("the operator exists and reads the recorded runs", () => {
  assert.ok(BODY, "backup-unprotected is gone");
  assert.match(BODY, /from backup_runs/);
  assert.match(BODY, /order by ran_at desc/, "it must judge on the LATEST run");
});

test("an empty table is silence, not an alarm", () => {
  // THE MISTAKE THIS WOULD SHIP WITH. The table is empty the day the migration
  // applies and stays empty until 03:15 -- while backups run correctly the
  // whole time. Reporting "no backup" from an absence of ROWS is reporting on
  // the recording rather than on the backup, which is the same error as calling
  // a job stalled ninety seconds after the worker booted.
  assert.match(BODY, /if \(!latest\) return \[\]/);
});

test("a failed run is recorded, or the operator reads a stale success", () => {
  // Every abort in the script goes through fail(). Without an insert there, a
  // run that died leaves LAST night's success as the newest row -- and an
  // operator reading "the last run was fine" would be reading a row from before
  // the problem, reporting all-clear on the morning it matters most.
  const failFn = SCRIPT.slice(SCRIPT.indexOf("fail() {"), SCRIPT.indexOf("exit 1", SCRIPT.indexOf("fail() {")));
  assert.match(failFn, /record_run false false/, "a failed backup records nothing");
});

test("recording is best-effort and never fails the backup", () => {
  // A backup that succeeded and could not file its paperwork is still a
  // backup. Failing the run over the report would turn a reporting problem
  // into a data-protection one.
  assert.match(SCRIPT, /Could not record this run in backup_runs/);
  assert.match(SCRIPT, /\|\| log "Could not record/, "the insert must not abort the script");
});

test("one finding per condition, not one per night", () => {
  // A backup failing every night for a week is ONE problem. A fingerprint
  // carrying the run would raise a fresh finding each morning and bury the
  // other twenty operators under it.
  assert.match(BODY, /backup-failed/);
  assert.match(BODY, /backup-stale/);
  assert.match(BODY, /backup-not-off-box/);
  assert.ok(
    !/\$\{latest\.ran_at\}/.test(BODY),
    "the fingerprint must not vary with the run, or every night is a new finding"
  );
});

test("not off-box is reported even when the backup worked", () => {
  // The case the whole operator was written for: a dump that restores cleanly,
  // sitting on the disk it protects. Reporting it only alongside a failure
  // would mean never reporting it at all.
  assert.match(BODY, /!latest\.off_box && !latest\.failed_reason/);
  assert.match(BODY, /Backups are not leaving this machine/);
});

test("the finding names the file and the two values", () => {
  // Its destination is the operators list itself -- there is no settings screen
  // for this and inventing one would be a screen built to be wrong about
  // whether it had worked. So the detail has to carry the fix.
  assert.match(BODY, /etc\/nexus-backup\.env/);
  assert.match(BODY, /BACKUP_REMOTE and BACKUP_PASSPHRASE/);
  assert.match(BODY, /rclone is already installed/);
});

test("missing one night is late; being late by an hour is not", () => {
  // The dump runs at 03:15. A threshold under 24 hours fires on a run that
  // started slightly late, which is the fastest way to teach somebody to
  // ignore an urgent finding about their backups.
  const threshold = /BACKUP_STALE_HOURS = (\d+)/.exec(OPERATORS);
  assert.ok(threshold, "the staleness threshold is gone");
  assert.ok(Number(threshold[1]) > 24, "under a day would fire on a late run");
  assert.ok(Number(threshold[1]) <= 48, "over two days is not noticing");
});

test("the table it reads is protected like every other", () => {
  // Migration 052 put RLS on every tenant table and a test holds the line
  // after it. This table has no tenant, and the honest answer to that
  // challenge is a policy rather than an entry on an exception list -- a check
  // that can be argued around is one people learn to argue around.
  assert.match(MIGRATION, /alter table backup_runs enable row level security/i);
  assert.match(MIGRATION, /using \(true\)/);
  // And the reason `using (true)` is correct here has to be written down, or it
  // is indistinguishable from somebody switching RLS off to clear an error.
  const prose = MIGRATION.slice(0, MIGRATION.indexOf("alter table backup_runs enable"));
  assert.match(prose, /no tenant whose data this is/);
});

test("it says nothing about tenants it cannot speak for", () => {
  // The rows hold a timestamp, a size, a count, a boolean and the script's own
  // error. No customer name, no number, no message body -- which is what makes
  // the all-tenants policy safe rather than lazy.
  // SQL comments, not JS ones. `withoutComments` strips `//` and `/* */`, so it
  // left the prose in -- and this assertion was reading the paragraph that
  // EXPLAINS there are no customer names in the table as evidence that there
  // are. Stripping `--` lines is what the check actually needed.
  const code = MIGRATION.split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const forbidden of ["contact", "message", "wa_id", "organization_id"]) {
    assert.ok(!code.includes(forbidden), `backup_runs must not carry ${forbidden}`);
  }
});

test("an owner may decide against off-box, and only that finding stops", () => {
  // The owner decided on 2026-08-27 to keep backups on the machine. Five
  // findings that can never clear would be exactly the permanent noise this
  // deck argues against everywhere else, and the fastest way to teach somebody
  // that a warn badge means nothing.
  //
  // NOT a deletion and NOT a dismissal. The horizons have no "forever" on
  // purpose; a standing business decision is a different thing and belongs
  // written down where the next person reads it.
  assert.match(BODY, /BACKUP_OFFSITE_WAIVED === "1"/);
  assert.match(BODY, /!offsiteWaived/);

  // OFF BY DEFAULT. A new deployment must still be told -- a waiver that
  // defaults to on would silence a platform whose owner never chose anything.
  assert.match(
    read("docker-compose.prod.yml"),
    /BACKUP_OFFSITE_WAIVED: \$\{BACKUP_OFFSITE_WAIVED:-0\}/,
    "the waiver must default to 0"
  );
});

test("the waiver silences the nag and never the fact", () => {
  // The two branches that matter MORE once backups are local-only: if the
  // nightly run fails or stops, that is now the entire safety net gone. Neither
  // may be affected by the waiver.
  // Asserted on the CONDITIONS rather than on a slice of the file. The first
  // version cut from "latest.failed_reason" to "backup-not-off-box" and caught
  // the `const offsiteWaived` declaration that sits between them -- reporting a
  // leak that was not there. A test about which branch reads a flag should read
  // the branches, not the lines near them.
  assert.match(BODY, /if \(latest\.failed_reason\) \{/, "the failed branch must not consult the waiver");
  assert.match(BODY, /\} else if \(hours > BACKUP_STALE_HOURS\) \{/, "the stale branch must not either");

  // Exactly two mentions: the declaration, and the one condition it guards.
  const mentions = BODY.split("offsiteWaived").length - 1;
  assert.equal(mentions, 2, `offsiteWaived appears ${mentions} times — it must guard one branch only`);

  // And backup-check still says it on every run, so the fact stays visible even
  // though the deck has stopped asking about it.
  const CHECK = read("scripts", "backup-check.sh");
  assert.match(CHECK, /NOT OFF-BOX/, "the gate must still state the fact on every run");
  assert.ok(
    !CHECK.includes("BACKUP_OFFSITE_WAIVED"),
    "the gate must keep reporting off-box regardless of the waiver"
  );
});
