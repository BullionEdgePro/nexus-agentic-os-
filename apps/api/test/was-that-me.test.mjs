/**
 * "Last signed in Tuesday" cannot answer "was that me?"
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * `last_login_at` has been written on every sign-in for months and shown
 * nowhere, and nothing has ever recorded WHAT signed in. A date on its own says
 * whether an account is still in use. The question somebody actually asks when
 * they look at their own record is different: was that me, or was that
 * somebody with my access code?
 *
 * The label has to be recognisable and it has to be honest. A confidently wrong
 * "Chrome on Windows" ends the question; "Unrecognised device" prompts a second
 * look, which is the outcome worth protecting.
 *
 * These are assertions about real user-agent strings, taken from the browsers
 * these five businesses are actually used from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { describeDevice } from "@nexus/shared";

test("the ordinary cases read like something a person would recognise", () => {
  assert.equal(
    describeDevice(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
    ),
    "Chrome on Windows"
  );
  assert.equal(
    describeDevice(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1"
    ),
    "Safari on iPhone"
  );
  assert.equal(
    describeDevice(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15"
    ),
    "Safari on Mac"
  );
});

test("every Chromium browser claims to be Safari, so order decides the answer", () => {
  // THE MISTAKE THIS ORDERING EXISTS TO AVOID. Edge's UA contains both
  // "Chrome/" and "Safari/", Chrome's contains "Safari/", and Chrome on iOS
  // contains all three. Testing in the wrong order labels every Edge user as
  // Chrome -- plausible, wrong, and it ends the "was that me?" question with
  // the wrong answer.
  assert.equal(
    describeDevice(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"
    ),
    "Edge on Windows"
  );
  assert.equal(
    describeDevice(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1"
    ),
    "Chrome on iPhone",
    "Chrome on iOS claims Safari AND CriOS"
  );
  assert.equal(
    describeDevice(
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36"
    ),
    "Samsung Internet on Android",
    "Samsung Internet claims Chrome, and Android before Linux"
  );
});

test("Android is not reported as Linux", () => {
  // Android's UA contains "Linux". A staff member signing in from their phone
  // should not be recorded as a Linux desktop -- the two are recognisable to a
  // reader as different things, which is the entire purpose of the label.
  assert.equal(
    describeDevice(
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"
    ),
    "Chrome on Android"
  );
});

test("it says it does not know, rather than guessing", () => {
  // The honest shrug. A reader deciding whether a sign-in was theirs is better
  // served by being told the platform does not recognise something.
  assert.equal(describeDevice("curl/8.4.0"), "Unrecognised device");
  assert.equal(describeDevice("Some-Internal-Monitor/1.0"), "Unrecognised device");
  assert.match(describeDevice("Mozilla/5.0 (Windows NT 10.0)"), /Windows/);
  assert.match(describeDevice("Mozilla/5.0 (Windows NT 10.0)"), /Unrecognised browser/);
});

test("a missing or hostile header never breaks a sign-in", () => {
  // This runs while somebody is signing in. A sign-in that failed because a
  // header was strange would be a far worse outcome than an unlabelled record,
  // so there is no input that throws and none that returns empty.
  for (const input of [null, undefined, "", "   "]) {
    assert.equal(describeDevice(input), "Unknown device");
  }
  const huge = "Chrome/1 " + "x".repeat(50_000);
  assert.ok(describeDevice(huge).length <= 60, "a spoofed header must not write a novel into the row");
});

test("the label is short enough to sit in a row on the team screen", () => {
  const longest = describeDevice(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"
  );
  assert.ok(longest.length <= 60);
});
