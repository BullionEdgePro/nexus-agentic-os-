/**
 * Editing what the agent is told to be.
 *
 * ============================================================
 * THE SETTING THAT COULD ONLY BE CHANGED BY SSH
 * ============================================================
 *
 * `agent_configs.system_prompt` was written in exactly one place — `onboardBusiness`,
 * called from a CLI script. No route touched it and no screen showed it. It is
 * the standing instruction underneath every reply this platform sends: more
 * than the knowledge base, which only supplies facts, and more than the
 * procedures, which apply only where they match.
 *
 * ============================================================
 * WHY THE HISTORY IS THE FEATURE, NOT THE EDIT
 * ============================================================
 *
 * A bad prompt does not fail. It answers — plausibly, slightly wrongly, to
 * everyone — until somebody reads a transcript and notices, which on this
 * platform's traffic could be weeks. Every other layer that shapes a reply has
 * a way back: a procedure is proposed and reviewed, a phrase is switched off, a
 * knowledge source is deleted and re-added. This had none, so an edit made at
 * 2am was permanent unless whoever made it kept a copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { MIN_PROMPT_CHARS, MAX_PROMPT_CHARS } from "@nexus/db";
import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const DB = read("packages", "db", "src", "agent-config.ts");
const ROUTE = withoutComments(read("apps", "api", "src", "routes", "agent.ts"));
const PAGE = withoutComments(read("apps", "web", "app", "deck", "agent", "page.tsx"));
const MIGRATION = read(
  "packages",
  "db",
  "migrations",
  "068-what-the-agent-is-told-to-be.sql"
);

// ============================================================
// There is always a way back
// ============================================================

test("every change keeps the text it replaced", () => {
  // Not a diff. A diff needs the previous row to reconstruct, and the row
  // before it, and this table has to be readable on the worst day rather than
  // the tidiest.
  assert.match(MIGRATION, /create table if not exists agent_config_versions/);
  assert.match(MIGRATION, /system_prompt\s+text not null/);
  assert.ok(
    DB.includes("insert into agent_config_versions"),
    "a change does not record what it replaced"
  );
});

test("the old version is written BEFORE the new one takes effect", () => {
  // Of the two ways for a half-finished write to be wrong, a history entry with
  // no matching change is the recoverable one. A change with no way back is
  // not.
  const at = DB.indexOf("export async function setSystemPrompt");
  assert.ok(at > -1);
  const fn = DB.slice(at);
  const insertAt = fn.indexOf("insert into agent_config_versions");
  const updateAt = fn.indexOf("update agent_configs");
  assert.ok(insertAt > -1 && updateAt > -1);
  assert.ok(insertAt < updateAt, "the prompt is replaced before its predecessor is kept");
});

test("both writes are one transaction", () => {
  const at = DB.indexOf("export async function setSystemPrompt");
  const fn = DB.slice(at);
  assert.ok(fn.includes('await pool.query("begin")'));
  assert.ok(fn.includes("rollback"), "a failure could leave the history and the config disagreeing");
});

test("restoring an old version goes through the same confirmation as any change", () => {
  // The screen loads it into the box rather than saving it. Putting yesterday's
  // prompt back is still changing what every customer is told.
  assert.ok(
    PAGE.includes("onClick={() => setDraft(version.systemPrompt)}"),
    "restoring writes directly, skipping the confirmation every other change gets"
  );
});

// ============================================================
// What it refuses
// ============================================================

test("a prompt too short to be an instruction is refused", () => {
  // Under this it is a typo, and the agent would answer every customer from it.
  assert.ok(MIN_PROMPT_CHARS >= 20, "the floor is low enough to let a typo through");
  assert.ok(DB.includes("next.length < MIN_PROMPT_CHARS"));
});

test("a prompt long enough to be a document is refused, and says where it belongs", () => {
  // Not an architectural limit -- it would still send. It is the point where
  // the right home is the knowledge base, which is retrieved on relevance
  // rather than prepended to every reply including the ones about opening
  // hours.
  assert.ok(MAX_PROMPT_CHARS > 1000 && MAX_PROMPT_CHARS <= 20000);
  assert.ok(DB.includes("next.length > MAX_PROMPT_CHARS"), "nothing refuses an oversized prompt");
  // The refusal says where the content belongs instead, which is the part that
  // stops somebody simply pasting it back in two halves.
  //
  // (An earlier version of this test built a slice from
  // `indexOf("MAX_PROMPT_CHARS limit")` — a string that is not in the file,
  // because the source interpolates the constant in the middle of it. indexOf
  // returned -1, the slice was garbage, and nothing used it. Caught by
  // `an-extraction-that-found-nothing`, minutes after being written, which is
  // the detector doing exactly the job it was built for.)
  assert.ok(DB.includes("belongs in the knowledge base"), "the refusal does not say what to do instead");
});

test("saving an unchanged prompt writes no history", () => {
  // Thirty rows recording nothing are what make a history unreadable on the day
  // it is needed.
  assert.ok(
    DB.includes("current.systemPrompt.trim() === next"),
    "an unchanged save would write a version recording nothing"
  );
});

test("a refusal is a sentence, not a code", () => {
  const at = DB.indexOf("export async function setSystemPrompt");
  const fn = DB.slice(at);
  for (const fragment of ["An agent needs a real instruction", "belongs in the knowledge base"]) {
    assert.ok(fn.includes(fragment), `a refusal that says only "invalid" teaches nothing: ${fragment}`);
  }
});

// ============================================================
// Who may change it
// ============================================================

test("only an operator may read or change it", () => {
  // Most screens on this deck are reachable by an employee, on the reasoning
  // that a business's own operational information is not management
  // information about its staff. This is different in kind: it changes what the
  // COMPANY says, on the next message, with no review step anywhere.
  const gets = ROUTE.split('scope.role !== "operator"').length - 1;
  assert.equal(gets, 2, "both the read and the write must refuse an employee");
  assert.ok(ROUTE.includes("403"));
});

test("the change is attributed to a person", () => {
  assert.ok(ROUTE.includes("changedBy: scope.sub"));
  assert.match(MIGRATION, /replaced_by/);
});

test("the log records the length, never the text", () => {
  // The prompt is in the database and in its own history table. Repeating it
  // into a log adds nothing and puts a business's own wording somewhere it did
  // not choose to put it.
  const at = ROUTE.indexOf('"The system prompt was changed');
  assert.ok(at > -1, "the most consequential change on the deck is not recorded");
  const line = ROUTE.slice(ROUTE.lastIndexOf("logger.info", at), at);
  assert.ok(line.includes("characters:"), "the log does not say how much changed");
  assert.ok(!line.includes("systemPrompt:"), "the prompt text is being logged");
});

// ============================================================
// What the screen says before somebody presses Save
// ============================================================

test("the screen says there is no review step, before the typing", () => {
  // Everything else on this deck that changes what a customer is told has one.
  // Somebody should know that while they are typing rather than afterwards.
  assert.ok(PAGE.includes("There is no review step here"), "the screen does not say what it does");
  assert.ok(
    PAGE.indexOf("There is no review step here") < PAGE.indexOf("className=\"ag-prompt\""),
    "the warning comes after the box it is about"
  );
});

test("saving asks first, and names the consequence rather than the action", () => {
  assert.ok(PAGE.includes("window.confirm("));
  assert.ok(
    PAGE.includes("Every reply after this one is generated from the new text"),
    "the confirmation describes a button rather than what happens"
  );
});

test("the limits come from the server, so the counter cannot disagree with the rule", () => {
  assert.ok(ROUTE.includes("limits: { min: MIN_PROMPT_CHARS, max: MAX_PROMPT_CHARS }"));
  assert.ok(PAGE.includes("setLimits(data.limits)"), "the screen carries its own copy of the limits");
});

test("never changed is stated as a fact, not left blank", () => {
  // Null means nobody has touched it since the business was set up, which is
  // worth knowing rather than reading as missing data.
  assert.ok(PAGE.includes("Never changed since this business was set up"));
});
