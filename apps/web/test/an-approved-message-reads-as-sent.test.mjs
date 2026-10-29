/**
 * The picker shows what an approved message says (29 Oct 2026): the first
 * blank as the client's first name, any others as the dash Nexus sends.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fillPlaceholders } from "../lib/template-placeholders.ts";

test("{{1}} is a first name and later blanks are the dash Nexus sends", () => {
  assert.equal(fillPlaceholders("Hi {{1}}, your {{2}} is ready", "Ahmed Al-Mansouri"), "Hi Ahmed, your - is ready");
  assert.equal(fillPlaceholders("Hi {{1}}", null), "Hi Sara");
});
