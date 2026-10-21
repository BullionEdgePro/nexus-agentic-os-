// A placeholder account is not asked for.
//
// The App Review sandbox business (review-demo) has no WhatsApp account, and
// stores `none-review-demo` because the column is required. The half-hourly
// template sync sent that to Meta, got a 400, and logged a level-50 error every
// run — burying real failures in the log the health checks read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isMetaAccountId } from "../src/services/template-sync.ts";

test("a real Meta account id is synced", () => {
  assert.equal(isMetaAccountId("1555307469433965"), true);
});

test("the sandbox placeholder, an empty id and no id are skipped", () => {
  assert.equal(isMetaAccountId("none-review-demo"), false);
  assert.equal(isMetaAccountId(""), false);
  assert.equal(isMetaAccountId(null), false);
  assert.equal(isMetaAccountId(undefined), false);
});
