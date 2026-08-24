/**
 * A control character sitting in source, where an escape was meant to be.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * `\b` written through one layer of escaping too few does not become `\b`. It
 * becomes 0x08 — an actual backspace byte in the file. The source still parses,
 * the regex still compiles, and it now matches a character no source file has
 * ever contained. Every `.test()` returns false and every negated assertion
 * built on it returns true, for ever.
 *
 * That is not a hypothetical. Both live instances were found on 2026-08-24 by
 * the first run of this scan:
 *
 *   the-same-mistake-twice.test.mjs      the register's own honesty check. It
 *                                        looked for names of tests and gates
 *                                        inside coverage notes; the pattern
 *                                        required a backspace, so it examined
 *                                        NOTHING and passed.
 *
 *   routed-traffic-is-counted-...mjs     "no policy casts the tenant setting to
 *                                        uuid" — the guard against an unguarded
 *                                        `current_setting('app.current_org',
 *                                        true)::uuid`, which is the defect
 *                                        migration 056 exists to fix and which
 *                                        made policies throw or silently return
 *                                        rows depending on planner order. Never
 *                                        once ran.
 *
 * Both were green. Both looked exactly like a passing test. Neither could ever
 * have failed.
 *
 * ============================================================
 * WHY IT IS WORTH HAVING WHEN THE CLASS IS "UNCOVERABLE"
 * ============================================================
 *
 * The register records a-heredoc-that-eats-a-backslash with `kind: "none"`,
 * because the damage happens in transit between an editing tool and the disk and
 * leaves nothing distinguishable from a typo. That is true of HALF of it: `\\s`
 * collapsing to `s` produces a valid regex that is merely wrong, and no scanner
 * can know it was not intended.
 *
 * The other half is not like that at all. When the eaten escape was one of
 * \b \f \v \0 \a, the result is a byte that has no business being in source and
 * cannot be typed by accident. That half is trivially detectable, and it is the
 * more dangerous half, because a mangled character class usually breaks loudly
 * while a control character silently makes a pattern unmatchable.
 *
 * So: not the whole class, and the register says which part.
 */
import { REPO_ROOT, lineAt, read, relative, walk } from "../source.mjs";
import { join } from "node:path";

export const id = "a-control-character-in-source";

const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".sh", ".sql", ".css"];

// C0 controls and DEL, minus the three that are ordinary whitespace here.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

const NAMES = {
  0x00: "NUL", 0x07: "BEL (\\a)", 0x08: "BACKSPACE (\\b)", 0x0b: "VERTICAL TAB (\\v)",
  0x0c: "FORM FEED (\\f)", 0x1b: "ESC", 0x7f: "DEL",
};

export function detect() {
  const findings = [];
  let checked = 0;

  for (const dir of ["apps", "packages", "scripts"]) {
    for (const file of walk(join(REPO_ROOT, dir), (name) =>
      EXTENSIONS.some((ext) => name.endsWith(ext))
    )) {
      checked++;
      const src = read(file);
      FORBIDDEN.lastIndex = 0;
      const seen = new Set();
      for (const m of src.matchAll(FORBIDDEN)) {
        const line = lineAt(src, m.index);
        if (seen.has(line)) continue; // one finding per line is enough to act on
        seen.add(line);
        const code = m[0].codePointAt(0);
        findings.push({
          where: `${relative(file)}:${line}`,
          what:
            `holds a raw ${NAMES[code] ?? `control character 0x${code.toString(16).padStart(2, "0")}`}. ` +
            `Almost always an escape that lost a level in transit — a regex written with \\b or ` +
            `\\f arriving as the byte itself, which then matches something no source file contains, ` +
            `so the pattern never fires and anything negating it passes for ever.`,
        });
      }
    }
  }

  return { findings, checked, unchecked: [] };
}
