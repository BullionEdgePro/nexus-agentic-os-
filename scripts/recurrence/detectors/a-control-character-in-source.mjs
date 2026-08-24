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
import { REPO_ROOT, lineAt, read, relative, walk, withoutComments } from "../source.mjs";
import { join } from "node:path";

export const id = "a-control-character-in-source";

// Built from its code point so this file cannot become an instance of the thing
// it detects. The first version of the message below was exactly that.
const BS = String.fromCharCode(92);

const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".sh", ".sql", ".css"];

// C0 controls and DEL, minus the three that are ordinary whitespace here.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

const NAMES = {
  0x00: "NUL", 0x07: "BEL (\\a)", 0x08: "BACKSPACE (\\b)", 0x0b: "VERTICAL TAB (\\v)",
  0x0c: "FORM FEED (\\f)", 0x1b: "ESC", 0x7f: "DEL",
};

/**
 * The same damage one step later: an escape that survives into the FILE and
 * becomes a control character only when the program runs.
 *
 * Inside a template literal a lone `\b` is the BACKSPACE ESCAPE, so
 * `new RegExp(`\b${name}\b`)` is handed two 0x08 bytes and matches nothing. The
 * other classes fail differently and just as quietly: `\d`, `\w` and `\s` are
 * unrecognised escapes in a string literal and simply LOSE THEIR BACKSLASH, so
 * the pattern quietly means the letter.
 *
 * Found 2026-08-24 in queue-health, where it made "every queue this platform
 * runs is watched" unable to match any queue name at all. A regex needs `\\b`
 * in a template literal, or no template literal.
 *
 * There is no legitimate use of the single-escaped form here, which is why this
 * is worth flagging on sight rather than measuring first.
 */
function templateRegexEscapes(src) {
  // COMMENTS FIRST. This detector's own header quotes the broken pattern as an
  // example, and its first run duly reported itself. Prose that mentions a
  // regex is not a regex.
  src = withoutComments(src);
  const out = [];
  const NEEDLE = "new RegExp(";
  const TICK = String.fromCharCode(96);
  let at = src.indexOf(NEEDLE);
  while (at !== -1) {
    const seg = src.slice(at, at + 400);
    const open = seg.indexOf(TICK);
    if (open >= 0 && open < 30) {
      const close = seg.indexOf(TICK, open + 1);
      const literal = close === -1 ? seg.slice(open + 1) : seg.slice(open + 1, close);
      const single = [];
      for (const cls of ["b", "d", "w", "s", "S", "D", "W", "B"]) {
        const one = String.fromCharCode(92) + cls;
        const two = String.fromCharCode(92, 92) + cls;
        if (literal.includes(one) && !literal.includes(two)) single.push(one);
      }
      if (single.length > 0) out.push({ at, classes: single });
    }
    at = src.indexOf(NEEDLE, at + 1);
  }
  return out;
}

export function detect() {
  const findings = [];
  let checked = 0;

  for (const dir of ["apps", "packages", "scripts"]) {
    for (const file of walk(join(REPO_ROOT, dir), (name) =>
      EXTENSIONS.some((ext) => name.endsWith(ext))
    )) {
      checked++;
      const src = read(file);

      for (const escape of templateRegexEscapes(src)) {
        findings.push({
          where: `${relative(file)}:${lineAt(src, escape.at)}`,
          what:
            `builds a regex from a template literal containing ${escape.classes.join(", ")}. ` +
            "In a template literal those are STRING escapes, not regex ones: " +
            BS + "b becomes a backspace byte, and " + BS + "d, " + BS + "w, " + BS +
            "s lose their backslash entirely. The pattern matches something other than " +
            "what it says, usually nothing. Double the backslash, or drop the template literal.",
        });
      }

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
