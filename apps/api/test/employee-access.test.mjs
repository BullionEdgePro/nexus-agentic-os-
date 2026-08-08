// Employee sign-in credentials and tenant scoping.
//
// Until this landed there was exactly ONE credential for the whole platform,
// and everyone who used it saw all five businesses' customer conversations.
// These are the two things that have to hold now: a code cannot be forged, and
// a valid employee session cannot reach a business that is not theirs.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateAccessCode,
  normalizeAccessCode,
  hashAccessCode,
  verifyAccessCode,
} from "@nexus/employees";

// ============================================================
// Access codes
// ============================================================

test("issued codes avoid glyphs people misread aloud", () => {
  // These get read over the phone and typed on a handset. 0/O and 1/I/l are a
  // support ticket waiting to happen.
  for (let i = 0; i < 200; i++) {
    const code = generateAccessCode();
    assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/, code);
    assert.ok(!/[01IOL]/.test(code), `ambiguous glyph in ${code}`);
  }
});

test("issued codes are not predictable", () => {
  // Not a statistical test — just proof the generator is not returning a
  // constant or cycling a short list, which is the failure that would matter.
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(generateAccessCode());
  assert.equal(seen.size, 500);
});

test("a code verifies however it is typed back in", () => {
  const code = generateAccessCode();
  const stored = hashAccessCode(code);

  const bare = normalizeAccessCode(code);
  for (const typed of [code, bare, bare.toLowerCase(), ` ${code} `, code.replace("-", " ")]) {
    assert.ok(verifyAccessCode(typed, stored), `should verify: "${typed}"`);
  }
});

test("a wrong code does not verify", () => {
  const stored = hashAccessCode("ABCDE-FGHJK");
  for (const wrong of ["ABCDE-FGHJM", "ABCDE", "", "ABCDEFGHJKX"]) {
    assert.equal(verifyAccessCode(wrong, stored), false, wrong);
  }
});

test("the stored value reveals nothing usable", () => {
  const code = generateAccessCode();
  const stored = hashAccessCode(code);

  assert.ok(stored.startsWith("scrypt$"));
  assert.ok(!stored.includes(normalizeAccessCode(code)), "the code must not appear in its own hash");

  // Salted, so two employees issued the identical code do not share a row value
  // — and a leaked hash cannot be matched against another account.
  assert.notEqual(hashAccessCode(code), stored);
});

test("an employee with no code issued cannot sign in", () => {
  // Migration 011 backfills nothing, so every pre-existing employee row has a
  // null hash. That must deny, not throw and not pass.
  for (const stored of [null, undefined, "", "garbage", "scrypt$notxhex$alsonot", "scrypt$aa$bb"]) {
    assert.equal(verifyAccessCode("ABCDE-FGHJK", stored), false, JSON.stringify(stored));
  }
  console.log("PASS: no access code means no sign-in — the migration grants nobody anything");
});

// ============================================================
// Tenant scoping
// ============================================================

const { requireTenantScope, requireConversationScope, operatorOnly } = await import(
  "../src/middleware/require-tenant-scope.ts"
);

/** Minimal Hono-shaped context: only what the middleware actually touches. */
function contextFor({ scope, params = {}, path = "/api/organizations/zipicka/employees" }) {
  const captured = { status: null, body: null };
  return {
    ctx: {
      get: (key) => (key === "scope" ? scope : undefined),
      req: { param: (name) => params[name], path, method: "GET" },
      json: (body, status = 200) => {
        captured.body = body;
        captured.status = status;
        return captured;
      },
    },
    captured,
  };
}

const OPERATOR = { sub: "owner@nexusagenticos.com", role: "operator" };
const LEGAL_STAFF = {
  sub: "ivan@jurisprimelegal.ae",
  role: "employee",
  employeeId: "emp-1",
  organizationId: "org-legal",
  organizationSlug: "juris-prime-legal",
};

test("an employee reaches their own business", async () => {
  let passed = false;
  const { ctx } = contextFor({ scope: LEGAL_STAFF, params: { slug: "juris-prime-legal" } });
  await requireTenantScope(ctx, async () => {
    passed = true;
  });
  assert.ok(passed);
});

test("an employee is refused another business — this is the whole point", async () => {
  // Scoping the UI is presentation. An employee who opens devtools calls the
  // API directly, so if this check is not here then "scoped access" means
  // nothing at all.
  let passed = false;
  const { ctx, captured } = contextFor({ scope: LEGAL_STAFF, params: { slug: "zipicka" } });
  await requireTenantScope(ctx, async () => {
    passed = true;
  });
  assert.equal(passed, false, "the handler must never run");
  assert.equal(captured.status, 403);
});

test("the operator is unrestricted", async () => {
  for (const slug of ["zipicka", "juris-prime-legal", "sfs-international"]) {
    let passed = false;
    const { ctx } = contextFor({ scope: OPERATOR, params: { slug } });
    await requireTenantScope(ctx, async () => {
      passed = true;
    });
    assert.ok(passed, slug);
  }
});

test("a missing scope fails closed, not open", async () => {
  // requireAuth always sets one, so absence means a wiring mistake. Treating an
  // unknown caller as an operator is how a refactor becomes a breach.
  let passed = false;
  const { ctx, captured } = contextFor({ scope: undefined, params: { slug: "zipicka" } });
  await requireTenantScope(ctx, async () => {
    passed = true;
  });
  assert.equal(passed, false);
  assert.equal(captured.status, 403);
});

test("a tenant route with no slug is refused rather than waved through", async () => {
  let passed = false;
  const { ctx, captured } = contextFor({ scope: LEGAL_STAFF, params: {} });
  await requireTenantScope(ctx, async () => {
    passed = true;
  });
  assert.equal(passed, false);
  assert.equal(captured.status, 403);
});

test("cross-tenant endpoints refuse employees outright", async () => {
  let passed = false;
  const { ctx, captured } = contextFor({ scope: LEGAL_STAFF, path: "/api/metrics/overview" });
  await operatorOnly(ctx, async () => {
    passed = true;
  });
  assert.equal(passed, false, "there is no scoped version of every business's metrics");
  assert.equal(captured.status, 403);

  let operatorPassed = false;
  const { ctx: opCtx } = contextFor({ scope: OPERATOR, path: "/api/metrics/overview" });
  await operatorOnly(opCtx, async () => {
    operatorPassed = true;
  });
  assert.ok(operatorPassed);
  console.log("PASS: an employee session cannot act like an operator one");
});
