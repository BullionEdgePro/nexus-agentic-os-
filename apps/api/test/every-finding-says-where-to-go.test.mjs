// A finding said what was wrong and gave no way to reach it.
//
// The operators deck lists "Ahmed has been waiting 3 hours" and, until now,
// rendered it as text. Every finding has carried a subjectKind and subjectId
// the whole time — `operator-fire-check` refuses one without a subject, and
// failed a new operator for exactly that this afternoon — and the UI used
// neither. The only way to reach that conversation was to open the inbox and
// find the name by eye.
//
// THE MAP IS KEYED ON THE OPERATOR, NOT THE SUBJECT KIND, and that is the
// substance of it. Ten of the sixteen operators carry subjectKind
// "organization" — thin-knowledge, template-rejected, unowned-followup,
// procedure-awaiting-review — and the screen you fix them on differs every
// time. The subject says what the finding is about; only the operator says
// what you would do about it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

const OPERATORS = readFileSync(
  join(root, "apps", "api", "src", "services", "operators.ts"),
  "utf8"
);
const WHERE = readFileSync(
  join(root, "apps", "web", "app", "deck", "operators", "where-to-fix-it.ts"),
  "utf8"
);
const PAGE = readFileSync(
  join(root, "apps", "web", "app", "deck", "operators", "page.tsx"),
  "utf8"
);

const operatorSlugs = () =>
  [...OPERATORS.matchAll(/slug: "([a-z-]+)"/g)].map((m) => m[1]);

const mappedSlugs = () =>
  [...WHERE.matchAll(/^\s*"([a-z-]+)":\s*\{/gm)].map((m) => m[1]);

test("every operator has somewhere to send you", () => {
  const missing = operatorSlugs().filter((slug) => !mappedSlugs().includes(slug));
  assert.deepEqual(
    missing,
    [],
    `these findings would render as dead text: ${missing.join(", ")}\n` +
      "Add each to WHERE in where-to-fix-it.ts, choosing the screen its own " +
      "detail text tells the reader to go to."
  );
});

test("every screen it links to is a route that exists", () => {
  // The deck's directory IS its routing table, so this cannot drift from a
  // second list. `inbox` is the one page outside /deck.
  const deck = join(root, "apps", "web", "app", "deck");
  const routes = new Set(
    readdirSync(deck, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(deck, e.name, "page.tsx")))
      .map((e) => e.name)
  );
  routes.add("inbox");
  assert.ok(existsSync(join(root, "apps", "web", "app", "inbox", "page.tsx")));

  const screens = [...new Set([...WHERE.matchAll(/screen: "([a-z-]+)"/g)].map((m) => m[1]))];
  const broken = screens.filter((s) => !routes.has(s));
  assert.deepEqual(broken, [], `links point at routes that do not exist: ${broken.join(", ")}`);
});

test("the two conversation findings open the conversation, not just the inbox", () => {
  // customer-waiting and handover-abandoned are the only findings whose subject
  // is a specific conversation, and they are the ones where landing on a list
  // and hunting by name is the whole problem being fixed.
  for (const slug of ["customer-waiting", "handover-abandoned"]) {
    const entry = WHERE.slice(WHERE.indexOf(`"${slug}":`));
    assert.match(entry.slice(0, 120), /screen: "inbox", conversation: true/, slug);
  }
  assert.match(WHERE, /\/inbox\?business=\$\{business\}&conversation=/);
});

test("a finding with no subject degrades instead of linking nowhere", () => {
  // The subject can legitimately be absent, and a link to
  // "?conversation=undefined" would be worse than the business's inbox.
  assert.match(WHERE, /finding\.subjectId\s*\n?\s*\?/);
  assert.match(WHERE, /: `\/inbox\?business=\$\{business\}`/);
});

test("the inbox actually reads the parameters the link sets", () => {
  // The link is only as good as the page receiving it. This page kept its
  // selection in a client store and read nothing from the URL, which is why
  // findings could not link to a conversation in the first place.
  const inbox = readFileSync(join(root, "apps", "web", "app", "inbox", "page.tsx"), "utf8");
  assert.match(inbox, /useSearchParams/);
  assert.match(inbox, /params\.get\("business"\)/);
  assert.match(inbox, /params\.get\("conversation"\)/);
  // Applied once. Re-applying would drag somebody back to the linked
  // conversation every time they clicked a different one.
  assert.match(inbox, /if \(applied\.current\) return;/);
  // And the business is set before the conversation, because setSelectedOrg
  // clears the selection.
  const body = inbox.slice(inbox.indexOf("applied.current = true"));
  assert.ok(
    body.indexOf("setSelectedOrg") < body.indexOf("selectConversation"),
    "selecting the conversation before the business undoes it"
  );
});

test("only findings with a destination become links", () => {
  assert.match(PAGE, /whereToFixIt\(finding\) \? \(/);
  assert.match(PAGE, /<p className="op-title">\{finding\.title\}<\/p>/);
});
