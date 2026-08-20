// Nine times, the same defect: a read scoped to the wrong business.
//
// All five firms answer on one WhatsApp number, so the reply pipeline runs in
// the NUMBER OWNER's transaction while the thing being read belongs to the
// SERVING business. Under RLS that is not an error — it is zero rows, which
// every caller correctly reads as "this business has nothing configured".
//
// Each instance was fixed where it was found, and each time the same sentence
// appeared in the commit: correct today, because every caller happens to wrap
// it. That is a convention, and a convention is a property nobody can check.
//
//   hasStaffOnShift          escalation promised staff who were never told
//   getActivePhrase          the firm's own words replaced by the default
//   handoff release          four customers muted for sixteen days
//   loadActiveAgentConfig    no reply at all for seventeen hours
//   searchKnowledge          every answer would have been "I'll check"
//   hasActiveEmployees       caught before it fired
//   operator findings        alerts named the wrong firm
//   findRecentBroadcastSender  a campaign reply shown a menu
//   listBookingsInWindow     an empty diary reads as a free afternoon
//
// This is the check that makes the tenth one fail here instead of in front of a
// customer: EVERY database reader the agent packages can reach, which filters
// by organization_id, must widen at the read rather than trust its callers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

/**
 * Readers exempt from widening, each for a stated reason.
 *
 * A list, deliberately, and a short one. The alternative — inferring intent
 * from the code — is how a reader gets exempted by accident.
 */
const EXEMPT = {
  // Writes, not reads. They run in the owner's transaction and the row belongs
  // there; the trigger from migration 054 fills in who it is about.
  recordInboundMessage: "a write, and the owner owns the row",
  rememberContact: "a write, wrapped by its caller in withTenant",
};

/** Every symbol the agent packages import from @nexus/db. */
function agentReachable() {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(p);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/import \{([^}]*)\} from "@nexus\/db"/gs)) {
        for (const raw of m[1].split(",")) {
          const n = raw.trim();
          if (n && !n.startsWith("type")) names.add(n);
        }
      }
    }
  };
  walk(join(root, "packages", "agents", "src"));
  return names;
}

/** Exported functions in @nexus/db, with their bodies. */
function dbFunctions() {
  const out = [];
  const dir = join(root, "packages", "db", "src");
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(dir, file), "utf8");
    for (const m of src.matchAll(/export async function (\w+)\(/g)) {
      const start = m.index + m[0].length;
      const next = src.indexOf("\nexport ", start);
      out.push({ file, name: m[1], body: src.slice(start, next === -1 ? undefined : next) });
    }
  }
  return out;
}

test("every reader the agent can reach widens itself", () => {
  const reachable = agentReachable();
  const offenders = [];

  for (const fn of dbFunctions()) {
    if (!reachable.has(fn.name)) continue;
    if (fn.name in EXEMPT) continue;

    // Only functions that actually scope by tenant. A lookup by primary key has
    // no business to be wrong about.
    const sql = [...fn.body.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join(" ");
    if (!/\borganization_id = \$1\b/.test(sql)) continue;

    if (!fn.body.includes("withServingTenant")) {
      offenders.push(`${fn.file}: ${fn.name}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these are read by the agent in the number owner's transaction and will " +
      "return zero rows for a serving business, which looks like an empty " +
      `configuration rather than a bug:\n  ${offenders.join("\n  ")}\n\n` +
      "Wrap the body in withServingTenant(organizationId, () => <name>Scoped(...)), " +
      `or add it to EXEMPT with the reason it is safe.`
  );
});

test("the checker can actually fail", () => {
  // A check that cannot fail is worse than none. Re-run the same scan with the
  // widening textually removed, and it must find the readers again.
  const dir = join(root, "packages", "db", "src");
  let wouldFlag = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(dir, file), "utf8").replaceAll("withServingTenant", "plainRead");
    for (const m of src.matchAll(/export async function (\w+)\(/g)) {
      const start = m.index + m[0].length;
      const next = src.indexOf("\nexport ", start);
      const body = src.slice(start, next === -1 ? undefined : next);
      const sql = [...body.matchAll(/`([^`]*)`/g)].map((x) => x[1]).join(" ");
      if (/\borganization_id = \$1\b/.test(sql) && !body.includes("withServingTenant")) wouldFlag++;
    }
  }
  assert.ok(wouldFlag > 0, "the scan finds nothing even with every widening removed");
});

test("every exemption states why", () => {
  // The escape hatch is not a way to switch the check off. Each entry has to
  // carry an argument somebody can disagree with.
  for (const [name, reason] of Object.entries(EXEMPT)) {
    assert.ok(reason.length > 12, `${name} is exempt without a reason`);
  }
});
