/**
 * Which source file each identifier in a test file actually holds.
 *
 * Shared by every detector that reasons about this repository's source-scanning
 * tests, because they all need the same answer and getting it wrong is silent.
 * The first detector to need it had its own copy, resolved every path three
 * levels too deep, and reported a clean tree while checking two assertions out
 * of 219 — so there is one copy now, and it is tested.
 *
 * Only the idioms this repository actually uses are resolved. Everything else
 * comes back in `unchecked` with a reason, never assumed. A scanner that stays
 * quiet about what it could not parse reports a clean tree and means "I checked
 * the easy half".
 */
import { REPO_ROOT, exists, read, walk } from "./source.mjs";
import { dirname, join, resolve } from "node:path";

export const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";

/** Every test file in the workspace. */
export function testFiles() {
  return walk(join(REPO_ROOT, "apps"), (n) => n.endsWith(".test.mjs")).concat(
    walk(join(REPO_ROOT, "packages"), (n) => n.endsWith(".test.mjs"))
  );
}

/** Balanced-paren scan from the index of an opening paren. Returns its index, or -1. */
export function matchParen(src, open) {
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

/** The literal string segments of an argument list, or null if any argument is not a plain literal. */
export function literalArgs(argText) {
  const parts = argText.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const out = [];
  for (const part of parts) {
    const m = /^(["'`])((?:\\.|(?!\1).)*)\1$/.exec(part);
    if (!m || m[2].includes("${")) return null;
    out.push(m[2]);
  }
  return out;
}

/** Where each path-holding identifier points. */
function pathBindings(testFile, src) {
  const bases = new Map();
  bases.set("__here__", dirname(testFile));

  for (const m of src.matchAll(
    new RegExp(`const\\s+(${IDENT})\\s*=\\s*dirname\\(fileURLToPath\\(import\\.meta\\.url\\)\\)`, "g")
  )) {
    bases.set(m[1], dirname(testFile));
  }

  // Two passes, so `const root = join(here, "..")` resolves whichever order it is written in.
  for (let pass = 0; pass < 2; pass++) {
    for (const m of src.matchAll(
      new RegExp(`const\\s+(${IDENT})\\s*=\\s*(?:join|resolve)\\(\\s*(${IDENT})\\s*,([^)]*)\\)`, "g")
    )) {
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
 * the base. Dropping them — capturing `here` out of `join(here, "..", "..",
 * "..", ...p)` and throwing the three `..` away — is how the first version of
 * this resolved every path three levels too deep.
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
    const lit = literalArgs(arg);
    if (lit === null) return null;
    segs.push(lit[0]);
  }
  return resolve(base, ...segs);
}

/**
 * Identifiers bound to a whole source file, verbatim.
 *
 * "Verbatim" is load-bearing and is checked rather than assumed: anything
 * between the closing paren of the read and the semicolon — a `.replace`, a
 * `.slice`, a `.split` — means the binding is no longer the file.
 *
 * Returns { bound: Map<name, absolutePath>, unchecked: [{name, why}] }.
 */
export function wholeFileBindings(testFile, src) {
  const bases = pathBindings(testFile, src);
  const readBase = readHelperBase(src, bases);
  const bound = new Map();
  const unchecked = [];

  for (const m of src.matchAll(new RegExp(`const\\s+(${IDENT})\\s*=\\s*read\\(`, "g"))) {
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
      unchecked.push({ name, why: "resolved to a path that does not exist" });
      continue;
    }
    bound.set(name, target);
  }

  return { bound, unchecked };
}

/** Interpret the escapes a JS string literal would carry into its value. */
export function unescape(literal) {
  return literal.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (whole, esc) => {
    if (esc === "n") return "\n";
    if (esc === "t") return "\t";
    if (esc === "r") return "\r";
    if (esc === "0") return "\0";
    if (esc[0] === "u" || esc[0] === "x") {
      const hex = esc.startsWith("u{") ? esc.slice(2, -1) : esc.slice(1);
      return String.fromCodePoint(parseInt(hex, 16));
    }
    return esc;
  });
}

export { read };
