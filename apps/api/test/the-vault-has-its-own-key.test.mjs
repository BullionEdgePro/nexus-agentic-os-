// The vault has its own key, and refuses card numbers (Business HQ spec §5.2, §5.6).
//
// The vault holds the logins to every website, host and social account of five
// businesses. Its key is NEXUS_VAULT_KEY and nothing else: unlike the token key
// there is no fallback to the session secret, so a leak of either of those does
// not open it, and a server without the key refuses to save or reveal rather
// than quietly sealing with something guessable. Run for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sealVaultSecret, openVaultSecret, vaultConfigured } from "@nexus/db";
import { looksLikeCardNumber } from "@nexus/shared";

const KEY_A = "a".repeat(20) + "-vault-key-for-tests-only-0001";
const KEY_B = "b".repeat(20) + "-vault-key-for-tests-only-0002";

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a password goes in and comes back out, sealed differently every time", () => {
  withEnv({ NEXUS_VAULT_KEY: KEY_A }, () => {
    assert.equal(vaultConfigured(), true);
    const a = sealVaultSecret("p@ss w0rd!");
    const b = sealVaultSecret("p@ss w0rd!");
    assert.notEqual(a, b, "a fresh IV per seal");
    assert.ok(!a.includes("p@ss"), "nothing readable in the sealed form");
    assert.equal(openVaultSecret(a), "p@ss w0rd!");
  });
});

test("without its own key the vault refuses, even when the other secrets are set", () => {
  withEnv({ NEXUS_VAULT_KEY: undefined, NEXUS_TOKEN_KEY: "t".repeat(40), NEXUS_SESSION_SECRET: "s".repeat(40) }, () => {
    assert.equal(vaultConfigured(), false);
    assert.throws(() => sealVaultSecret("x"), /VAULT_NOT_CONFIGURED/);
  });
  withEnv({ NEXUS_VAULT_KEY: "too-short" }, () => {
    assert.equal(vaultConfigured(), false, "a short key is no key");
  });
});

test("a password sealed under one key does not open under another", () => {
  const sealed = withEnv({ NEXUS_VAULT_KEY: KEY_A }, () => sealVaultSecret("secret"));
  withEnv({ NEXUS_VAULT_KEY: KEY_B }, () => {
    assert.throws(() => openVaultSecret(sealed));
  });
});

test("a payment card number is recognised, and ordinary values are not", () => {
  assert.equal(looksLikeCardNumber("4111 1111 1111 1111"), true);
  assert.equal(looksLikeCardNumber("my card 5500-0000-0000-0004 thanks"), true, "found inside other text");
  assert.equal(looksLikeCardNumber("4111-1111-1111-1112"), false, "fails Luhn");
  assert.equal(looksLikeCardNumber("+971 52 563 1476"), false, "a phone number");
  assert.equal(looksLikeCardNumber("myPass2026"), false);
  assert.equal(looksLikeCardNumber(""), false);
});

// FINAL REVIEW, Important 4: only the greedy longest digit run was tested, so
// the common paste formats got through into plain-text notes.
test("a card is caught in the way people actually paste it", () => {
  assert.equal(looksLikeCardNumber("Visa 4111 1111 1111 1111 12/27"), true);
  assert.equal(looksLikeCardNumber("4111-1111-1111-1111 123"), true);
  assert.equal(looksLikeCardNumber("+971 4111111111111111"), true);
  assert.equal(looksLikeCardNumber("call +971 52 563 1476 after 6"), false);
});
