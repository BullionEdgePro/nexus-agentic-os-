// There was no error boundary anywhere in this app.
//
// No error.tsx, no global-error.tsx, no not-found.tsx. A render error therefore
// produced a completely blank white page: no message, no heading, no
// navigation, nothing to click. Found by driving the screens — four went white
// and the only evidence was a stack trace in a console the reader is not
// looking at.
//
// A blank page is the worst failure this console can present, because it is
// indistinguishable from every other blank page. "The platform is down", "my
// connection dropped", "I mistyped the URL" and "one component threw" all look
// identical, and only one of them is worth telephoning anybody about. This
// codebase is an extended argument against silences that cannot be told apart;
// the screens were the one place it had not been made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..", "web");
const read = (...p) => readFileSync(join(web, ...p), "utf8");

const DECK = read("app", "deck", "error.tsx");
const INBOX = read("app", "inbox", "error.tsx");
const GLOBAL = read("app", "global-error.tsx");
const NOT_FOUND = read("app", "not-found.tsx");
const TOKENS = read("app", "deck", "deck.css");

test("every reachable area has a boundary", () => {
  for (const f of [
    ["app", "deck", "error.tsx"],
    ["app", "inbox", "error.tsx"],
    ["app", "global-error.tsx"],
    ["app", "not-found.tsx"],
  ]) {
    assert.ok(existsSync(join(web, ...f)), `${f.join("/")} is missing`);
  }
});

test("no boundary shows the reader the error message", () => {
  // error.message names components and properties. It is written for whoever
  // wrote the code, and putting it in front of a person is the same mistake as
  // "Failed to fetch" — which took a whole pass to undo.
  for (const [name, src] of [["deck", DECK], ["inbox", INBOX], ["global", GLOBAL]]) {
    assert.ok(
      !/\{error\.message\}/.test(src),
      `the ${name} boundary renders error.message at somebody`
    );
    // It must still reach the log, or the digest below matches nothing.
    assert.match(src, /console\.error\(/, `the ${name} boundary swallows the error entirely`);
  }
});

test("each offers the digest, which is the part worth quoting", () => {
  // A short server-assigned id: meaningless alone, exact in a log search. It is
  // the difference between "a screen broke" and a report somebody can action.
  for (const [name, src] of [["deck", DECK], ["inbox", INBOX], ["global", GLOBAL]]) {
    assert.match(src, /error\.digest/, `the ${name} boundary offers nothing to quote`);
  }
});

test("each offers a way out, not just an apology", () => {
  // `reset` re-renders the segment. Worth offering first: a render error from a
  // transient state often does not recur, and reloading the whole console
  // costs whatever else was open.
  assert.match(DECK, /onClick=\{reset\}/);
  assert.match(INBOX, /onClick=\{reset\}/);
  assert.match(GLOBAL, /onClick=\{reset\}/);
  // And a second door, because reset does not always help.
  assert.match(DECK, /href="\/deck\/operators"/);
  assert.match(INBOX, /href="\/deck\/operators"/);
});

test("the inbox boundary names what is actually at risk", () => {
  // A deck screen failing costs a view. The inbox failing costs the ability to
  // see that a customer is waiting — the one thing here with a clock on it. So
  // it points at the screen that still answers that question.
  assert.match(INBOX, /still answering customers|agent is unaffected/i);
  assert.match(INBOX, /See who is waiting/);
  assert.ok(
    !/No message has been sent, altered or lost/.test(DECK),
    "the two boundaries have become the same text and one of them is now wrong"
  );
});

test("not-found is worded as an address, not as a fault", () => {
  // A 404 is the one failure here that is nobody's fault and nothing to report.
  // Wording it like an error sends people to report a stale link.
  assert.match(NOT_FOUND, /nothing to report/i);
  assert.ok(!/error\.digest/.test(NOT_FOUND), "a missing page has nothing to quote");
  assert.ok(!/"use client"/.test(NOT_FOUND), "a static page does not need to ship JavaScript");
});

test("the global boundary depends on nothing it might be catching", () => {
  // It REPLACES the root layout, so it renders its own <html> and <body> and
  // cannot rely on the stylesheets, fonts or tokens — whatever broke may be
  // exactly the thing that was meant to provide them.
  assert.match(GLOBAL, /<html/);
  assert.match(GLOBAL, /<body/);
  assert.ok(!/import .*deck\.css/.test(GLOBAL), "the last-resort boundary imports a stylesheet");
  assert.ok(!/fontVariables/.test(GLOBAL), "the last-resort boundary depends on the font module");
  assert.ok(!/var\(--/.test(GLOBAL), "the last-resort boundary reads theme tokens");
});

test("its hardcoded palette is checked against the real one", () => {
  // THE COST OF THAT INDEPENDENCE. Those literals cannot be tokens, so nothing
  // updates them when the palette moves — and the CSS-literal gate only reads
  // .css files, so it does not see them either. This is the check that makes
  // the duplication safe: change a token and this fails until the one file that
  // cannot use tokens is changed to match.
  const token = (name) => {
    const m = new RegExp("--" + name + ":\\s*(#[0-9a-f]{3,8})", "i").exec(TOKENS);
    assert.ok(m, `--${name} is gone from the token block`);
    return m[1].toLowerCase();
  };
  for (const name of ["marble", "paper", "ink", "slate", "hairline", "pebble"]) {
    assert.ok(
      GLOBAL.toLowerCase().includes(token(name)),
      `global-error.tsx no longer uses --${name} (${token(name)}) — the palette moved without it`
    );
  }
});
