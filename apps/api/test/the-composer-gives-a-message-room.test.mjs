// The composer gives a message room (owner's request, 12 Oct 2026: "this inbox
// is too small to enter messages").
//
// The box was one line tall and grew only on Shift+Enter: its height was
// `rows = number of newlines`, so a long sentence that WRAPPED stayed squeezed
// into one scrolling line. Now it starts at three lines, grows with what is
// actually on screen (wrapped lines included), opens into a large writing
// space for long answers, gives the text the full width with the tools on a
// row beneath, and warns before WhatsApp's 4,096-character limit refuses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const PAGE = read("apps", "web", "app", "inbox", "page.tsx");
const CSS = read("apps", "web", "app", "inbox", "inbox.css");

const rule = (selector) => {
  const at = CSS.indexOf(`${selector} {`);
  assert.ok(at > -1, `${selector} is styled`);
  return CSS.slice(at, CSS.indexOf("}", at));
};

test("the height follows what is on screen, not the number of line breaks", () => {
  assert.ok(!PAGE.includes('draft.split("\\n").length'), "rows from newline count is gone");
  assert.match(PAGE, /box\.style\.height = "auto";/);
  assert.match(PAGE, /box\.scrollHeight/);
});

test("it starts three lines tall and can grow to a real share of the screen", () => {
  const input = rule(".ibx-input");
  assert.match(input, /min-height: 4\.6em;/);
  assert.match(input, /max-height: min\(40vh, 320px\);/);
  assert.match(rule(".ibx-compose.expanded .ibx-input"), /max-height: 62vh;/);
});

test("a long answer can open into a large writing space, and Escape closes it", () => {
  assert.match(PAGE, /aria-pressed=\{composeExpanded\}/);
  assert.match(PAGE, /ibx-compose\$\{composeExpanded \? " expanded" : ""\}/);
  assert.match(PAGE, /e\.key === "Escape" && composeExpanded/);
});

test("the text gets the full width and the tools sit on a row beneath it", () => {
  assert.match(rule(".ibx-compose"), /flex-direction: column;/);
  assert.match(PAGE, /className="ibx-compose-tools"/);
  assert.match(PAGE, /<span className="ibx-send-label">Send<\/span>/);
});

test("it warns before WhatsApp's 4,096-character limit refuses the message", () => {
  assert.match(PAGE, /const WHATSAPP_TEXT_LIMIT = 4096;/);
  assert.match(PAGE, /draft\.length > WHATSAPP_TEXT_LIMIT - 500/);
});
