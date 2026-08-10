// Admin accounts, and their separation from staff sign-in.
//
// "Admin" used to be any email address plus one shared password, entered on the
// same form the staff use. That has no identity (every action attributable to
// "whoever knew the password"), no revocation (removing one person means
// changing the secret for everyone), and an email field that is never checked —
// so it looks like an account and behaves like a passphrase.
//
// The scopes either side of this line are very different: an admin session sees
// every tenant's customer conversations, an employee session sees one business.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { hashSecret, verifySecret, generatePassword } from "@nexus/employees";
import { hashAccessCode, verifyAccessCode } from "@nexus/employees";

const here = dirname(fileURLToPath(import.meta.url));
const LOGIN_ROUTE = readFileSync(
  join(here, "..", "..", "web", "app", "api", "auth", "login", "route.ts"),
  "utf8"
);
const MIGRATION = readFileSync(
  join(here, "..", "..", "..", "packages", "db", "migrations", "016-admin-accounts.sql"),
  "utf8"
);

// ============================================================
// Passwords are not access codes
// ============================================================

test("a password is case-sensitive — unlike an access code", () => {
  // The whole reason secret.ts exists separately. Access codes are normalised
  // because they are read aloud and retyped; applying that to a password would
  // make `Correct` and `CORRECT` the same secret and silently shrink the
  // keyspace for every account that used a capital letter.
  const stored = hashSecret("CorrectHorse42");
  assert.ok(verifySecret("CorrectHorse42", stored));
  assert.equal(verifySecret("correcthorse42", stored), false, "case must matter in a password");
  assert.equal(verifySecret("CORRECTHORSE42", stored), false);
});

test("an access code stays case- and format-insensitive", () => {
  // The opposite policy, on the same scrypt implementation. Both must hold, or
  // one of the two credential types is broken.
  const stored = hashAccessCode("ABCDE-FGHJK");
  for (const typed of ["ABCDE-FGHJK", "abcde-fghjk", "ABCDEFGHJK", " abcde fghjk "]) {
    assert.ok(verifyAccessCode(typed, stored), `should verify: "${typed}"`);
  }
});

test("a generated password is long and unpredictable", () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const password = generatePassword();
    assert.equal(password.length, 20);
    assert.match(password, /^[A-Za-z2-9]+$/);
    seen.add(password);
  }
  assert.equal(seen.size, 300, "generated passwords must not repeat");
});

test("a stored password reveals nothing usable", () => {
  const password = generatePassword();
  const stored = hashSecret(password);
  assert.ok(stored.startsWith("scrypt$"));
  assert.ok(!stored.includes(password));
  // Salted: the same password hashed twice must not collide, so a leaked hash
  // cannot be matched against another account.
  assert.notEqual(hashSecret(password), stored);
});

test("a malformed or missing hash denies rather than throwing", () => {
  for (const stored of [null, undefined, "", "garbage", "scrypt$zz$zz", "scrypt$aa$bb"]) {
    assert.equal(verifySecret("anything", stored), false, JSON.stringify(stored));
  }
});

// ============================================================
// The two entrances do not check each other's credentials
// ============================================================

test("staff mode never calls the admin verifier", () => {
  // The structural property that makes the separation worth anything: a bug in
  // the staff path cannot mint an admin session, because that path has no route
  // to the admin check at all.
  // Only the branch inside the handler — slicing to end-of-file would sweep in
  // the helper DEFINITIONS below it and match on those, which is a property of
  // where functions are declared rather than of what the staff path calls.
  const staffBranch = LOGIN_ROUTE.slice(
    LOGIN_ROUTE.indexOf("const employee = await verifyEmployee"),
    LOGIN_ROUTE.indexOf("async function verifyAdmin")
  );
  assert.ok(!/verifyAdmin/.test(staffBranch), "the staff branch must not reach verifyAdmin");
  assert.ok(
    !/operatorPassword\(\)/.test(staffBranch),
    "the staff branch must not accept the shared operator password"
  );
});

test("admin mode never accepts an employee access code", () => {
  const adminBranch = LOGIN_ROUTE.slice(
    LOGIN_ROUTE.indexOf('if (mode === "admin")'),
    LOGIN_ROUTE.indexOf("const employee = await verifyEmployee")
  );
  assert.ok(adminBranch.length > 0, "the admin branch has moved");
  assert.ok(!/verifyEmployee/.test(adminBranch), "the admin branch must not reach verifyEmployee");
});

test("mode defaults to staff, never to admin", () => {
  // An omitted or unrecognised mode must fall to the LESS privileged path.
  // Defaulting the other way would make a malformed request an admin attempt.
  assert.match(LOGIN_ROUTE, /body\.mode === "admin" \? "admin" : "staff"/);
});

test("both entrances give the same answer to every failure", () => {
  // Distinguishing "no such account" from "wrong password" tells an attacker
  // which addresses exist — the half of the credential they do not have.
  assert.match(LOGIN_ROUTE, /That email and password don't match\./);
  assert.match(LOGIN_ROUTE, /That sign-in doesn't match\./);
});

// ============================================================
// The account table
// ============================================================

test("admin emails are unique case-insensitively", () => {
  // Two rows differing only by capitalisation would be two accounts that look
  // like one, with whichever sorted first winning the lookup.
  assert.match(MIGRATION, /create unique index[\s\S]*?on admins \(lower\(email\)\)/);
});

test("no admin account is seeded, and no default password exists", () => {
  // A default admin credential shipping with the schema is a back door whether
  // or not anyone remembers to change it.
  assert.ok(!/insert into admins/i.test(MIGRATION), "the migration must not seed an account");
  assert.ok(!/password/i.test(MIGRATION.split("--")[0] ?? ""), "no password literal at the top");
  assert.match(MIGRATION, /create-admin\.ts/, "it must point at the script that creates the first one");
  console.log("PASS: admin and staff sign-in are separate credentials on separate entrances");
});
