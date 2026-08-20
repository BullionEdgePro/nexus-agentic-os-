// The alerting shipped this afternoon and nothing said whether it was on.
//
// The operators page is written around one idea: an empty list must never read
// as good news unless it IS good news. It says when the sweep last ran, and
// says so bluntly when the sweep has never completed, precisely so a reader
// cannot mistake "not running" for "nothing wrong".
//
// The dispatcher then arrived with the same hole one step out. A fresh sweep
// and a short list say nothing about whether anybody is TOLD when that list
// grows at three in the morning, and the dispatcher is silent until somebody
// sets OPERATOR_ALERT_WEBHOOK_URL. Measured before it existed:
// broken-knowledge stood 4.7 hours on average across twenty-eight findings,
// and a knowledge outage that took 53 of one firm's 72 passages offline stood
// sixteen. All detected within ten minutes. None reached a person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const ROUTE = read("apps", "api", "src", "routes", "operators.ts");
const PAGE = read("apps", "web", "app", "deck", "operators", "page.tsx");

test("the API reports whether findings reach anybody", () => {
  assert.match(ROUTE, /alertsConfigured: alertTarget\(\) !== null/);
  assert.match(ROUTE, /alertsIncludeWarnings: alertTarget\(\)\?\.alsoWarn \?\? false/);
});

test("it reports a boolean and never the destination", () => {
  // A Slack incoming webhook carries its token in the path, and this response
  // goes to a browser. Whether it is set is the useful fact; what it is, is not
  // this page's business.
  const body = ROUTE.slice(ROUTE.indexOf("return c.json({"));
  assert.ok(
    !/operatorAlertWebhookUrl|target\.url|alertTarget\(\)\.url/.test(body),
    "the alert destination must not be serialised to the browser"
  );
});

test("the unconfigured wording names the consequence, not the setting", () => {
  // "Alerts are off" reads as a preference somebody chose. "These reach nobody
  // unless this page is open" is what it actually means, and is the part worth
  // acting on.
  // SCOPED TO WHAT RENDERS, with comments stripped. The first version searched
  // the whole file and matched the doc comment that EXPLAINS why not to say
  // "Alerts are off" -- a test that cannot tell a string from the sentence
  // arguing against it. The same mistake this suite caught in an operator
  // query earlier the same day.
  const body = PAGE.slice(PAGE.indexOf("function describeAlerts"));
  const rendered = body.slice(0, body.indexOf("\n}")).replace(/\/\*[\s\S]*?\*\//g, " ");
  assert.match(rendered, /nothing here reaches anybody unless this page is open/);
  assert.ok(
    !/Alerts are (off|disabled)/.test(rendered),
    "the wording softened back into a setting"
  );
});

test("and it distinguishes urgent-only from urgent-and-warnings", () => {
  // Warnings staying on the page is the default and a deliberate one. A reader
  // who sees warnings here and no notifications should be able to tell that is
  // by design rather than a fault.
  assert.match(PAGE, /Warnings stay on this page/);
  assert.match(PAGE, /Urgent findings and warnings are sent/);
});

test("the line shows whether or not there are findings", () => {
  // It was first placed inside the "nothing needs attention" branch, which is
  // exactly backwards: whether anybody is told matters MOST when the list is
  // not empty. That branch was simply where the sweep sentence happened to be.
  const empty = PAGE.indexOf("Nothing needs attention");
  const roster = PAGE.indexOf('<section className="op-roster">');
  const line = PAGE.indexOf("describeAlerts(sweep.alerts");
  assert.ok(line > -1, "the alert line is gone");
  assert.ok(
    line > empty && line < roster,
    "the alert line must sit outside the empty-state branch and before the roster"
  );
  // One occurrence in the render, not one per branch.
  assert.equal(
    (PAGE.match(/describeAlerts\(sweep\.alerts/g) ?? []).length,
    1,
    "the line is rendered more than once"
  );
});
