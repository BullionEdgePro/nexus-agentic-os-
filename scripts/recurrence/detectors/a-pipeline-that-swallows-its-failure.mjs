/**
 * A shell script that reads a pipeline's exit status without `pipefail`.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * Without `set -o pipefail`, a pipeline exits with the status of its LAST
 * command. `npm test | grep fail` succeeds whenever grep finds something, which
 * is precisely when the tests failed. The shell reports success for the failure
 * and reports it in the same words it uses for a pass.
 *
 * This project has made that mistake, by hand, at least four times:
 *
 *   - a migration whose failure was hidden by `... | tail -3; echo $?`, which is
 *     why DEPLOY.md warns about it;
 *   - three times in one day on 18 August, with `npm test 2>&1 | grep -E ... &&
 *     git commit`, which pushed a commit carrying three failing tests. The
 *     pre-commit hook exists because of that day and says so;
 *   - and it is the reason verify-all.sh writes every gate's output to a file
 *     and reads `$?` on the next line instead of piping.
 *
 * Three separate files in this repository warn about it in prose. Nothing
 * checked. Every shell script here happens to set pipefail today, which is a
 * convention held up by whoever last remembered it — and a convention that has
 * already failed four times is not a control.
 *
 * ============================================================
 * WHAT IT ACTUALLY DOES
 * ============================================================
 *
 * Any script containing a pipeline must enable pipefail before the first one.
 * A script with no pipelines needs nothing and is not asked for it, so the rule
 * cannot be satisfied by adding a line that does not matter.
 *
 * It cannot see a command typed at a prompt, which is where all four instances
 * actually happened. That limit is real and is the reason the hook and
 * verify-all.sh exist as well — this closes the half that lives in the repo.
 */
import { REPO_ROOT, lineAt, read, relative, walk } from "../source.mjs";
import { join } from "node:path";

export const id = "a-pipeline-that-swallows-its-failure";

// A pipe that is not `||`, not inside a comment, and not the `|` of a
// character class or a case pattern. Deliberately simple: over-reporting a
// pipeline here costs one `set -o pipefail`, which is correct anyway.
const PIPELINE = /(^|[^|])\|([^|]|$)/;

export function detect() {
  const shellFiles = walk(join(REPO_ROOT, "scripts"), (name, full) => {
    if (name.endsWith(".sh")) return true;
    // Hooks have no extension. They are shell and they gate every commit.
    return full.split(/[\\/]/).includes("githooks");
  });

  const findings = [];
  let checked = 0;

  for (const file of shellFiles) {
    const src = read(file);
    if (!/^#!.*\b(bash|sh)\b/.test(src)) continue;
    checked++;

    const pipefailAt = src.search(/set\s+[-a-z]*o?\s*[-a-z]*\bpipefail\b/);

    let firstPipe = -1;
    let offset = 0;
    for (const line of src.split("\n")) {
      const bare = line.replace(/#.*$/, "");
      if (PIPELINE.test(bare)) {
        firstPipe = offset;
        break;
      }
      offset += line.length + 1;
    }

    if (firstPipe < 0) continue; // no pipeline; nothing to swallow
    if (pipefailAt >= 0 && pipefailAt < firstPipe) continue;

    findings.push({
      where: `${relative(file)}:${lineAt(src, firstPipe)}`,
      what:
        pipefailAt < 0
          ? "runs a pipeline and never enables pipefail, so a failure inside the pipeline reports success."
          : "runs a pipeline BEFORE the line that enables pipefail, so this one still reports the last command's status.",
    });
  }

  return { findings, checked, unchecked: [] };
}
