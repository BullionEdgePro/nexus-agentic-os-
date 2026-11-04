/**
 * A staff code signs in (audit, 4 Nov 2026).
 *
 * The staff sign-in field invited "your email or staff code", and the API looks
 * staff up by either; but the field was type="email" (the browser refused to
 * submit a code) and the form's own check refused anything without an @. Staff
 * with no email on file could not sign in at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const LANDING = readFileSync(new URL("../app/landing.tsx", import.meta.url), "utf8");
const field = LANDING.slice(LANDING.indexOf('id="email"') - 40, LANDING.indexOf('id="email"') + 400);
const submit = LANDING.slice(LANDING.indexOf("async function onSubmit"), LANDING.indexOf("async function onSubmit") + 700);

test("the field takes a staff code as well as an email", () => {
  assert.doesNotMatch(field, /type="email"/);
  assert.match(field, /type="text"/);
  assert.match(field, /autoComplete="username"/);
});

test("only something written as an email is checked as one", () => {
  assert.doesNotMatch(submit, /if \(!\/\.\+@\.\+\\\.\.\+\/\.test\(email\.trim\(\)\)\) \{/);
  assert.match(submit, /email\.includes\("@"\)/);
});
