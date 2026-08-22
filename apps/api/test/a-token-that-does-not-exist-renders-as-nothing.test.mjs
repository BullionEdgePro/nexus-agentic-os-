// `var(--ink-3)` is not an error. It is a shrug.
//
// An unresolvable CSS custom property with no fallback makes the WHOLE
// declaration invalid, so the element quietly inherits its parent's value and
// renders something entirely plausible. No console warning, no build failure,
// no visual signature to spot in a screenshot — the text is simply a different
// colour than the one somebody chose, forever.
//
// FOUND, NOT IMAGINED. The accept/dismiss UI shipped on 2026-08-20 using
// --ink-1 and --ink-3, names carried over from a different palette and typed
// from memory. Six declarations — the Accept button, the accepted-findings
// toggle, the "accepted by" byline, the explanatory note — all of them dead on
// arrival and none of them noticed, through a full review, a deploy and ten
// gates. A seventh, --warn-bg, was live only through its fallback, which meant
// the fallback was the design.
//
// The theme rename that followed touched 21 files, which is exactly the change
// that mints this bug in bulk. Hence a check rather than another careful read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..", "web");

/**
 * Properties supplied by next/font at runtime.
 *
 * These are stamped onto the element as inline styles by the font loader, so
 * they are genuinely defined — just never in a stylesheet this check can read.
 * Listed explicitly rather than pattern-matched on `--font-`, so a typo'd font
 * variable still fails.
 */
const RUNTIME = new Set(["--font-display", "--font-body", "--font-mono"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(css|tsx?)$/.test(entry.name)) out.push(p);
  }
  return out;
}

test("every custom property a stylesheet reads is one something defines", () => {
  const files = walk(join(web, "app"));
  const defined = new Set(RUNTIME);
  const used = new Map();

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*(--[\w-]+)\s*:/gm)) defined.add(m[1]);
    for (const m of src.matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (!used.has(m[1])) used.set(m[1], new Set());
      used.get(m[1]).add(file.slice(web.length + 1));
    }
  }

  const dangling = [...used.entries()]
    .filter(([name]) => !defined.has(name))
    .map(([name, where]) => `${name} <- ${[...where].join(", ")}`);

  assert.deepEqual(
    dangling,
    [],
    "these render as nothing and look completely normal doing it:\n  " + dangling.join("\n  ")
  );
});

test("a fallback is not where the design lives", () => {
  // `var(--warn-bg, rgba(184,134,11,0.08))` worked, because the fallback did
  // all of it -- and that fallback was the OLD warm ochre, so it survived a
  // whole palette change by being invisible to it. A fallback is a safety net
  // for a token that exists; when the token does not exist, the fallback IS the
  // value and nobody can find it.
  //
  // Narrow on purpose: this bans a fallback naming a token nothing defines, not
  // fallbacks in general.
  const files = walk(join(web, "app")).filter((f) => f.endsWith(".css"));
  const defined = new Set(RUNTIME);
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/^\s*(--[\w-]+)\s*:/gm)) defined.add(m[1]);
  }

  const offenders = [];
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/var\(\s*(--[\w-]+)\s*,\s*([^)]+)\)/g)) {
      if (!defined.has(m[1])) offenders.push(`${f.slice(web.length + 1)}: ${m[1]} — only ever ${m[2].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n  "));
});

test("no stylesheet reaches for pure black or the old warm ground", () => {
  // The palette bans #000 outright: on a cool ground a warm-neutral black reads
  // as a hole rather than as text. The old vellum and blueprint literals are
  // banned for the reverse reason -- they were written by hand, so they were
  // invisible to a token retarget and survived it. #1d3fbf was still drawing
  // focus rings in a blue this palette no longer contains.
  //
  // COMMENTS ARE STRIPPED FIRST. Without that, this matched the sentence in
  // deck.css that explains why #000 is banned -- the third time in two days a
  // check here has failed to tell a quotation from a use. A rule about what the
  // code does must read the code.
  //
  // THE RGBA FORMS TOO, added after the hex-only version missed 61 of them
  // across 15 files. A palette retarget moves tokens; it cannot move a colour
  // written out by hand, and an old tint is invisible in review because it is a
  // plausible shade of the RIGHT HUE -- brick under crimson, ochre under amber,
  // blueprint under signal. The giveaway was the severity pill on the operators
  // deck rendering a crimson glyph on a brick background, and it was found by
  // looking at the rendered page, not at the source.
  //
  // @media print is exempt and is the one honest exception in this codebase:
  // black ink on white paper is correct, and those pages get printed.
  const banned =
    /#000000\b|#000\b|rgba\(0,\s*0,\s*0|#efeee6|#f7f6f0|#1d3fbf|#16160f|#9a9b8c|#5b5c50|rgba\(22,\s*22,\s*15|rgba\(239,\s*238,\s*230|rgba\(\s*162,\s*59,\s*46|rgba\(\s*169,\s*118,\s*47|rgba\(\s*63,\s*107,\s*74|rgba\(\s*29,\s*63,\s*191/i;
  const offenders = [];
  for (const f of walk(join(web, "app")).filter((x) => x.endsWith(".css"))) {
    const raw = readFileSync(f, "utf8");
    // Blank the comments rather than delete them, so line numbers still point
    // at the real line in the real file.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!banned.test(line)) return;
      const before = lines.slice(0, i).join("\n");
      if (before.lastIndexOf("@media print") > before.lastIndexOf("\n}")) return;
      offenders.push(`${f.slice(web.length + 1)}:${i + 1}  ${line.trim().slice(0, 70)}`);
    });
  }
  assert.deepEqual(offenders, [], "\n  " + offenders.join("\n  "));
});
