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
 */
import { REPO_ROOT, commentsOf, lineAt, read, relative, walk, withoutComments, exists } from "../source.mjs";
import { dirname, join, resolve } from "node:path";

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";

/** Balanced-paren scan from the index of an opening paren. Returns its index, or -1. */
function matchParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The literal string segments of a call's argument list, or null if any argument is not a plain literal. */
function literalArgs(argText) {
  const parts = argText.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const out = [];
  for (const part of parts) {
    const m = /^(["'`])((?:\\.|(?!\1).)*)\1$/.exec(part);
    if (!m || m[2].includes("${")) return null;
    out.push(m[2]);
  }
  return out;
}

/**
 * Where each path-holding identifier in a test file points.
 *
 * Only the two idioms this repository actually uses are resolved — `here` from
 * import.meta.url, and any identifier built from it with join/resolve. Anything
 * else resolves to null and its bindings are reported as unchecked rather than
 * assumed.
 */
function pathBindings(testFile, src) {
  const bases = new Map();
  const here = dirname(testFile);

  for (const m of src.matchAll(new RegExp(`const\\s+(${IDENT})\\s*=\\s*dirname\\(fileURLToPath\\(import\\.meta\\.url\\)\\)`, "g"))) {
    bases.set(m[1], here);
  }

  // Two passes, so `const root = join(here, "..")` resolves whichever order it is written in.
  for (let pass = 0; pass < 2; pass++) {
    for (const m of src.matchAll(new RegExp(`const\\s+(${IDENT})\\s*=\\s*(?:join|resolve)\\(\\s*(${IDENT})\\s*,([^)]*)\\)`, "g"))) {
      const base = bases.get(m[2]);
      if (base === undefined) continue;
      const segs = literalArgs(m[3]);
      if (segs === null) continue;
      bases.set(m[1], resolve(base, ...segs));
    }
  }

  return bases;
}

/**
 * The base directory the file's `read(...)` helper joins onto, or null.
 *
 * The literal segments BETWEEN the base identifier and the spread are part of
 * the base and were dropped by the first version of this function, which
 * captured `here` out of `join(here, "..", "..", "..", ...p)` and threw the
 * three `..` away. Every path it produced was three levels too deep, none of
 * them existed, and the detector reported 217 bindings it could not resolve
 * while claiming to have checked the tree. Silent under-coverage, in the
 * scanner written to find silent under-coverage.
 */
function readHelperBase(src, bases) {
  const m = new RegExp(
    `const\\s+read\\s*=\\s*\\(\\s*\\.\\.\\.(${IDENT})\\s*\\)\\s*=>\\s*readFileSync\\(\\s*(?:join|resolve)\\(`
  ).exec(src);
  if (!m) return null;
  const spread = m[1];
  const open = m.index + m[0].length - 1;
  const close = matchParen(src, open);
  if (close < 0) return null;

  const args = src.slice(open + 1, close).split(",").map((a) => a.trim());
  const base = bases.get(args[0]);
  if (base === undefined) return null;

  const segs = [];
  for (const arg of args.slice(1)) {
    if (arg === `...${spread}`) break;
    // literalArgs rather than a second literal regex here: one place decides
    // what counts as a plain string, so the two cannot drift apart.
    const lit = literalArgs(arg);
    if (lit === null) return null; // an expression this cannot evaluate; say so rather than guess
    segs.push(lit[0]);
  }
  return resolve(base, ...segs);
}

/**
 * Identifiers bound to a whole source file, verbatim.
 *
 * "Verbatim" is the load-bearing word and it is checked rather than assumed:
 * anything between the closing paren of the read and the semicolon — a
 * `.replace`, a `.slice`, a `.split` — means the binding is no longer the file,
 * so it is recorded as unchecked instead.
 */
function wholeFileBindings(testFile, src) {
  const bases = pathBindings(testFile, src);
  const readBase = readHelperBase(src, bases);
  const bound = new Map();
  const unchecked = [];

  const re = new RegExp(`const\\s+(${IDENT})\\s*=\\s*read\\(`, "g");
  for (const m of src.matchAll(re)) {
    const name = m[1];
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;

    const tail = src.slice(close + 1, src.indexOf(";", close) + 1).trim();
    if (tail !== ";") {
      unchecked.push({ name, why: "the binding is transformed before it is asserted on" });
      continue;
    }

    const segs = literalArgs(src.slice(open + 1, close));
    if (segs === null || readBase === null) {
      unchecked.push({ name, why: "the path could not be resolved from literals" });
      continue;
    }

    const target = join(readBase, ...segs);
    if (!exists(target)) {
      unchecked.push({ name, why: `resolved to ${relative(target)}, which does not exist` });
      continue;
    }
    bound.set(name, target);
  }

  return { bound, unchecked };
}

function unescape(literal) {
  return literal.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

export const id = "a-claim-satisfied-by-prose";

export function detect() {
  const testFiles = walk(join(REPO_ROOT, "apps"), (name) => name.endsWith(".test.mjs")).concat(
    walk(join(REPO_ROOT, "packages"), (name) => name.endsWith(".test.mjs"))
  );

  const findings = [];
  let checked = 0;
  const unchecked = [];
  const sourceCache = new Map();
  const loadStripped = (path) => {
    if (!sourceCache.has(path)) {
      const raw = read(path);
      sourceCache.set(path, { code: withoutComments(raw), comments: commentsOf(raw) });
    }
    return sourceCache.get(path);
  };

  for (const testFile of testFiles) {
    const src = read(testFile);
    const { bound, unchecked: skipped } = wholeFileBindings(testFile, src);
    for (const s of skipped) unchecked.push({ where: relative(testFile), name: s.name, why: s.why });

    for (const [name, target] of bound) {
      // Positive assertions only. A `!X.includes(...)` that matches a comment
      // makes the test red, and a red test is already being looked at; this
      // detector is for the direction nobody is looking at.
      const re = new RegExp(`(?<![!\\w$.])${name}\\s*\\.includes\\(\\s*(["'\`])((?:\\\\.|(?!\\1).)*)\\1\\s*\\)`, "g");
      for (const m of src.matchAll(re)) {
        const phrase = unescape(m[2]);
        if (phrase.trim() === "") continue;
        checked++;
        const { code, comments } = loadStripped(target);
        if (!comments.includes(phrase)) continue; // never in prose; nothing to confuse
        if (code.includes(phrase)) continue; // in the code too, so the claim stands on code
        findings.push({
          file: relative(testFile),
          line: lineAt(src, m.index),
          phrase,
          target: relative(target),
        });
      }
    }
  }

  return {
    findings: findings.map((f) => ({
      where: `${f.file}:${f.line}`,
      what:
        `requires ${JSON.stringify(f.phrase)} of ${f.target}, and that phrase exists ` +
        `there ONLY IN A COMMENT. The assertion is green on prose.`,
    })),
    checked,
    unchecked,
  };
}
