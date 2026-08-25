/**
 * Reading this repository's own source well enough to check it.
 *
 * Everything here is deliberately small and deliberately honest about what it
 * cannot parse. A scanner that silently skips the constructs it does not
 * understand reports a clean tree and means "I looked at the easy half" — which
 * is the failure mode this whole loop exists to stop, so every entry point here
 * returns what it SKIPPED alongside what it found.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage"]);

/** Every file under `dir` whose name matches `predicate`, depth-first. */
export function walk(dir, predicate, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".paul") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(full, predicate, out);
    } else if (predicate(entry.name, full)) {
      out.push(full);
    }
  }
  return out;
}

export function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export const read = (path) => readFileSync(path, "utf8");

/**
 * The character ranges of `src` that are comments.
 *
 * Hand-lexed rather than matched with a regex, because the whole point is to
 * tell prose from code and a regex cannot: `"https://x"` is a string containing
 * two slashes, and `/['"]/` is a regex literal containing two quotes. Getting
 * either wrong moves a span, and a moved span is a wrong answer delivered with
 * the same confidence as a right one.
 *
 * Regex literals are recognised by what precedes them. A `/` that follows an
 * operator or an opening bracket begins a pattern; a `/` that follows a value
 * is division. This is the standard heuristic and it is not perfect — the one
 * shape it gets wrong is a regex directly after `)`, as in `if (x) /re/.test(y)`,
 * which nothing in this repository writes.
 */
export function commentSpans(src) {
  const spans = [];
  const n = src.length;
  let i = 0;
  let prev = ""; // last significant character seen

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      const start = i;
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      spans.push([start, i]);
      continue;
    }

    if (c === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      spans.push([start, i]);
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === c) {
          i++;
          break;
        }
        i++;
      }
      prev = c;
      continue;
    }

    if (c === "/" && "(,=:[!&|?{};+*%<>~^".includes(prev)) {
      // A regex literal. Consumed whole so its slashes and quotes cannot be
      // mistaken for the start of a comment or a string.
      i++;
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) {
          i++;
          break;
        } else if (ch === "\n") break;
        i++;
      }
      prev = "/";
      continue;
    }

    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return spans;
}

/** The comment text of `src`, concatenated. Everything else is dropped. */
export function commentsOf(src) {
  return commentSpans(src)
    .map(([a, b]) => src.slice(a, b))
    .join("\n");
}

/** `src` with every comment replaced by a space, so offsets do not shift into each other. */
export function withoutComments(src) {
  const spans = commentSpans(src);
  if (spans.length === 0) return src;
  let out = "";
  let at = 0;
  for (const [a, b] of spans) {
    out += src.slice(at, a) + " ";
    at = b;
  }
  return out + src.slice(at);
}

/** 1-based line number of a character offset. */
export function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

/** Repo-relative, forward-slashed, for printing. */
export function relative(path) {
  return path.slice(REPO_ROOT.length + 1).split("\\").join("/");
}

/**
 * The comments of `src` as READABLE PROSE: gutter removed, whitespace collapsed.
 *
 * `commentsOf` returns comments verbatim, which is right for asking whether an
 * exact token appears in one. It is wrong for asking whether a SENTENCE does.
 * Block comments here are wrapped at 80 columns with a ` * ` gutter, so a
 * sentence spanning two lines reads as "The * agent offers..." once the newline
 * is collapsed, and a plain `includes` misses it — which is how the first
 * version of the test that needed this failed, twice, on prose that was there.
 *
 * A test that goes red for reformatting is a test people delete.
 */
export function proseOf(src) {
  return commentsOf(src)
    .replace(/^[ \t]*(\/\*+|\*+\/|\*)/gm, " ")
    .replace(/^[ \t]*\/\//gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One operator's definition, plus the body of any shared reader it hands off to.
 *
 * ============================================================
 * WHY THE HANDOFF HAS TO BE FOLLOWED
 * ============================================================
 *
 * Several tests assert properties of an operator's SQL by slicing from its
 * `const` to the next one. That works while every operator inlines its own
 * query, and silently stops working the moment one is extracted -- the slice
 * comes back without the SQL and the assertion fails as though the property
 * were gone.
 *
 * Two test files went red that way on 2026-08-25, when customer-waiting's query
 * moved into `unansweredConversations` so that the operator and the view of
 * what it SUPPRESSES would read the same rows through the same predicate. The
 * property was untouched; only its address moved.
 *
 * Both were right to go red -- a slice that quietly finds less is exactly the
 * "gate that passes on the wrong thing" this register already tracks. But a
 * checker that treats "extracted" as "deleted" pushes people to keep queries
 * inlined, which is how two copies of one predicate get written, which is the
 * defect the extraction was undoing. So it follows one level, and lives here
 * rather than being pasted into each file, because this repository has already
 * paid for two copies of a helper more than once.
 */
export function operatorBody(source, slug, readers = ["unansweredConversations"]) {
  const marker = `slug: "${slug}"`;
  const at = source.indexOf(marker);
  if (at === -1) return null;
  const start = source.lastIndexOf("const ", at);
  if (start === -1) return null;

  const next = source.indexOf("\nconst ", start + 1);
  let body = next === -1 ? source.slice(start) : source.slice(start, next);

  for (const reader of readers) {
    if (!body.includes(`${reader}(`)) continue;
    const readerAt = source.indexOf(`export async function ${reader}(`);
    if (readerAt === -1) continue;
    const ends = source.indexOf("\nexport ", readerAt + 1);
    body += ends === -1 ? source.slice(readerAt) : source.slice(readerAt, ends);
  }
  return body;
}
