/**
 * Routing keywords: the setting that decides which business a customer reaches.
 *
 * ============================================================
 * WHY THIS IS THE MOST CONSEQUENTIAL LIST ON THE PLATFORM
 * ============================================================
 *
 * Five businesses answer on one WhatsApp number, and two of them are competing
 * law firms. When somebody messages it, these words are how the platform works
 * out which firm they want. A word in the wrong list sends a client to the
 * wrong practice — silently, because from the platform's side nothing failed.
 *
 * `update organizations` appeared nowhere in this codebase until now. The list
 * was written by the onboarding script and could only be changed by connecting
 * to Postgres.
 *
 * ============================================================
 * THE REFUSAL THAT MATTERS
 * ============================================================
 *
 * `findSharedNumberBusinesses` excludes a business with no keywords — correctly,
 * because one the classifier can never reach should not be offered in the menu.
 * The consequence is that saving an empty list takes a business off the menu
 * entirely and it stops receiving customers, with nothing reporting it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { cleanKeywords, isKnownTimezone } from "@nexus/db";
import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const DB = read("packages", "db", "src", "organization-settings.ts");
const ROUTING = read("packages", "db", "src", "routing.ts");
const ROUTE = withoutComments(read("apps", "api", "src", "routes", "agent.ts"));
const PAGE = withoutComments(read("apps", "web", "app", "deck", "agent", "page.tsx"));

// ============================================================
// The refusal
// ============================================================

test("the exclusion this refusal protects against is real", () => {
  // Asserted at the source rather than assumed. If routing ever started
  // including keyword-less businesses, the refusal below would be protecting
  // against nothing and should be reconsidered rather than left standing.
  assert.match(
    ROUTING,
    /coalesce\(array_length\(routing_keywords, 1\), 0\) > 0/,
    "routing no longer excludes a business with no keywords — re-read the refusal in settings"
  );
});

test("emptying the keywords of a live shared-number business is refused", () => {
  assert.ok(
    DB.includes("keywords.length === 0 && current.isActive && current.acceptsSharedNumber"),
    "an empty keyword list can be saved, which silently takes the business off the menu"
  );
  // And the refusal says what would happen, not that it is invalid.
  assert.ok(
    DB.includes("customers could no longer reach it at all"),
    "the refusal does not name the consequence"
  );
});

test("a timezone the runtime does not know is refused", () => {
  // Every rota, booking window and forecast would fall back to UTC without
  // complaint -- resolvePresence carries a fellBackToUtc flag for exactly that
  // case, and this stops it being reachable from a screen.
  assert.equal(isKnownTimezone("Asia/Dubai"), true);
  assert.equal(isKnownTimezone("Europe/London"), true);
  assert.equal(isKnownTimezone("Mars/Olympus"), false);
  assert.equal(isKnownTimezone(""), false);
  assert.ok(DB.includes("quietly fall back to UTC"), "the refusal does not say why it matters");
});

// ============================================================
// Tidying without deciding
// ============================================================

test("keywords are lowercased, trimmed and de-duplicated", () => {
  assert.deepEqual(
    cleanKeywords([" Attestation ", "attestation", "NOTARY", "", "  ", "notary", "visa"]),
    ["attestation", "notary", "visa"]
  );
});

test("the order somebody typed is kept", () => {
  // There is no reason to disturb it, and a list that reorders itself on save
  // makes a person wonder what else changed.
  assert.deepEqual(cleanKeywords(["zebra", "apple", "mango"]), ["zebra", "apple", "mango"]);
});

test("cleaning cannot turn a non-empty list into an empty one silently", () => {
  // It CAN produce an empty list from all-blank input -- and that is precisely
  // the case the refusal above then catches, rather than being written twice.
  assert.deepEqual(cleanKeywords(["  ", ""]), []);
});

// ============================================================
// Collisions
// ============================================================

test("a word claimed by two businesses on one number is reported", () => {
  // Nothing anywhere could show this before. A shared word is a tie the
  // classifier breaks on a rule neither firm chose.
  assert.ok(DB.includes("export async function keywordCollisions"));
  const at = DB.indexOf("export async function keywordCollisions");
  const fn = DB.slice(at, DB.indexOf("export interface SettingsRefusal"));
  // Same number, different business, both live on it.
  assert.ok(fn.includes("o.whatsapp_phone_number_id = me.whatsapp_phone_number_id"));
  assert.ok(fn.includes("o.id <> me.id"));
  assert.ok(fn.includes("o.accepts_shared_number"));
  // Case-insensitively, or "Attestation" and "attestation" would look distinct.
  assert.ok(fn.includes("lower(ok) = lower(k)"));
});

test("a collision is reported and never prevented", () => {
  // Two businesses really can both do attestation. Refusing the overlap would
  // be this platform overruling a fact about the world; the people who own both
  // lists are the ones who should decide.
  assert.ok(
    !DB.includes("collision") || !/return \{\s*reason:[^}]*claimed by/.test(DB),
    "an overlapping keyword is being refused rather than shown"
  );
  assert.ok(PAGE.includes("Not an error: two businesses really can both do the same thing"));
});

test("the screen shows which business the word is shared with", () => {
  // "3 collisions" tells nobody what to do. The other firm's name is the part
  // that turns it into a conversation somebody can have.
  assert.ok(PAGE.includes("{clash.withName}"), "the collision does not name the other business");
  assert.ok(PAGE.includes("{clash.keyword}"), "the collision does not name the word");
});

// ============================================================
// What is written down about the change
// ============================================================

test("the log carries the counts, never the words", () => {
  // A keyword list is a business's commercial positioning. It belongs in its
  // own row rather than repeated into a log -- but a change in how many words
  // route to a firm sharing a number with a competitor is worth being able to
  // date afterwards.
  const at = ROUTE.indexOf(`"A business's settings were changed"`);
  assert.ok(at > -1, "changing the routing of a shared number is not recorded at all");
  const line = ROUTE.slice(ROUTE.lastIndexOf("logger.info", at), at);
  assert.ok(line.includes("keywordsBefore") && line.includes("keywordsAfter"));
  assert.ok(!line.includes("routingKeywords:"), "the keyword list is being logged");
});

test("the screen says a business with no keywords is left off the menu", () => {
  // Said before somebody empties the box, not in the error afterwards.
  assert.ok(
    PAGE.includes("a business") && PAGE.includes("left off the menu entirely"),
    "the screen does not explain what the list is for"
  );
});
