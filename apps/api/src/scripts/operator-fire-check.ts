/**
 * Has each alarm ever actually gone off?
 *
 *   docker compose -f docker-compose.prod.yml exec -T worker \
 *     npx tsx apps/api/src/scripts/operator-fire-check.ts
 *
 * ============================================================
 * WHY
 * ============================================================
 *
 * Sixteen operators sweep every business every ten minutes. On 2026-08-18,
 * `operator_findings` showed that exactly THREE of them had ever produced a
 * finding — `customer-waiting`, `handover-abandoned`, `overdue-followup`. The
 * other thirteen have run thousands of times and returned an empty array every
 * time, which is good news about the platform and no news at all about them.
 *
 * `schema-check` already runs every operator, so their QUERIES are known to
 * plan. What has never executed is the branch that BUILDS a finding: the title
 * with the count interpolated, the severity ternary, the detail sentence, the
 * fingerprint. That code is on the alarm path and it first runs during the
 * outage it exists to report — a `${undefined} of ${NaN}` in a title, or a
 * fingerprint that changes every pass and so can never be retracted, would
 * surface at the worst possible moment and look like the outage.
 *
 * So this seeds the condition each operator watches, inside a transaction that
 * is rolled back, and asserts the finding it produces is well formed.
 *
 * ============================================================
 * WHAT IT DOES NOT COVER, SAID OUT LOUD
 * ============================================================
 *
 * A gate covering part of the list while reading as complete is the failure this
 * codebase keeps meeting in new clothes, so the uncovered ones are listed at the
 * end of every run with the reason, and the run FAILS if an operator is neither
 * covered nor listed. Three shapes of reason survive:
 *
 *   - already fires in production, so a synthetic proof adds nothing;
 *   - cannot be seeded from inside a transaction at all — `schedule-stalled`
 *     reads `job_heartbeats` through `withAllTenants`, which opens its OWN
 *     connection, so an uncommitted seed is invisible to it;
 *   - CAN be seeded, and the seed would assert the wrong thing. `unowned-followup`
 *     is suppressed by design for a business with no staff, so seeding it against
 *     an empty roster would pin the opposite behaviour to the one intended; and
 *     `thin-knowledge` counts chunks against a floor that the probe source seeded
 *     for `broken-knowledge` would move, so the two would test each other rather
 *     than themselves. Those are reasons not to write a check, which is different
 *     from not having got round to it.
 */
import { pathToFileURL } from "node:url";
import {
  withTenant,
  withAllTenants,
  listOrganizations,
  getPool,
  insertOutboundMessage,
  insertEvaluation,
  recordConversationMetric,
  createTask,
  createBooking,
  upsertInferredProcedure,
} from "@nexus/db";
import { JUDGE_UNAVAILABLE } from "@nexus/governance";
import { OPERATORS } from "../services/operators.js";
import type { FindingInput } from "@nexus/db";

/** Not a dialable number, so this can never collide with a real contact. */
const PROBE_WA_ID = "999000000000003";

class RolledBack extends Error {}

interface Case {
  slug: string;
  /** Creates the condition. Runs inside the transaction that gets rolled back. */
  seed: (organizationId: string, conversationId: string, contactId: string) => Promise<void>;
  /** What a correct finding must say, beyond being well formed. */
  expect?: (finding: FindingInput) => string | null;
}

const CASES: Case[] = [
  {
    slug: "agent-unavailable",
    // Three fallbacks inside the six-hour window, which is the threshold that
    // turns a blip into a provider. Seeding two would exercise the warn branch
    // and leave the urgent one — the one that matters — unrun.
    seed: async (organizationId, conversationId) => {
      for (let i = 0; i < 3; i++) {
        await recordConversationMetric({
          organizationId,
          conversationId,
          intent: "knowledge_lookup",
          resolvedBy: "unresolved",
          inputTokens: 0,
          outputTokens: 0,
          replyOutcome: "fallback",
        });
      }
    },
    expect: (finding) =>
      finding.severity === "urgent" ? null : `three fallbacks should be urgent, got ${finding.severity}`,
  },
  {
    slug: "retrieval-unavailable",
    seed: async (organizationId, conversationId) => {
      await recordConversationMetric({
        organizationId,
        conversationId,
        intent: "knowledge_lookup",
        resolvedBy: "ai_agent",
        inputTokens: 1,
        outputTokens: 1,
        retrievalOutcome: "failed",
        replyOutcome: "agent",
      });
    },
    expect: (finding) =>
      finding.severity === "urgent" ? null : `a failed lookup should be urgent, got ${finding.severity}`,
  },
  {
    slug: "retrieval-unavailable/degraded",
    // The branch migration 047 added, and the one most likely to be wrong:
    // 'degraded' has to raise a WARNING rather than nothing, or the fallback
    // silently switches off the alarm it was written for.
    seed: async (organizationId, conversationId) => {
      await recordConversationMetric({
        organizationId,
        conversationId,
        intent: "knowledge_lookup",
        resolvedBy: "ai_agent",
        inputTokens: 1,
        outputTokens: 1,
        retrievalOutcome: "degraded",
        replyOutcome: "agent",
      });
    },
    expect: (finding) =>
      finding.severity === "warn"
        ? null
        : `keyword-answered replies should warn, not ${finding.severity} — see migration 047`,
  },
  {
    slug: "delivery-failing",
    seed: async (organizationId, conversationId, contactId) => {
      const message = await insertOutboundMessage({
        organizationId,
        conversationId,
        contactId,
        senderType: "system",
        body: "Operator fire check — not a real message.",
        waMessageId: `wamid.fire-check-${organizationId}`,
      });
      await getPool().query(
        `update messages set status = 'failed', delivery_error = 'fire check: not a real failure'
          where id = $1`,
        [message.id]
      );
    },
    expect: (finding) =>
      finding.severity === "urgent" ? null : `a rejected message should be urgent, got ${finding.severity}`,
  },
  {
    slug: "intent-unclassified",
    // Rows with no intent at all. The operator's own comment warns that this
    // number rising means the classifier stopped, which is the failure that
    // looks exactly like a quiet week.
    seed: async (organizationId, conversationId) => {
      for (let i = 0; i < 5; i++) {
        await recordConversationMetric({
          organizationId,
          conversationId,
          intent: null,
          resolvedBy: "ai_agent",
          inputTokens: 1,
          outputTokens: 1,
        });
      }
    },
  },
  {
    slug: "judge-offline",
    // The governance judge failing is stored as risk "medium" with a marker in
    // the notes, because a verdict that could not be reached must not read as a
    // verdict. This operator is the only thing that tells the two apart.
    seed: async (organizationId, conversationId, contactId) => {
      const message = await insertOutboundMessage({
        organizationId,
        conversationId,
        contactId,
        senderType: "ai_agent",
        body: "Operator fire check — not a real reply.",
      });
      await insertEvaluation(organizationId, message.id, {
        piiFlagged: false,
        hallucinationRisk: "medium",
        notes: `${JUDGE_UNAVAILABLE} (fire check)`,
      });
    },
  },
  {
    slug: "broken-knowledge",
    seed: async (organizationId) => {
      // `kind`, not `source_type` — the first version of this seed guessed the
      // column name and the gate reported FAIL rather than passing quietly,
      // which is the gate doing its job on its own author.
      await getPool().query(
        `insert into knowledge_sources (organization_id, kind, title, uri, status, error)
         values ($1, 'url', 'Fire check source', 'https://example.invalid/fire-check', 'failed',
                 'fire check: not a real failure')`,
        [organizationId]
      );
    },
  },
  {
    slug: "wording-awaiting-review",
    // Seeded with a placeholder still in it, because that is the branch a real
    // business hits: ABR wrote `no_one_available` wording containing
    // {{office_number}}, the route correctly refused to activate it, and
    // nothing told them. This proves the finding names the missing value rather
    // than only saying something is wrong.
    seed: async (organizationId) => {
      await getPool().query(
        `insert into agent_phrases (organization_id, moment, language, body, source, is_active)
         values ($1, 'handing_over', 'en',
                 'Operator fire check — not real wording. Call {{probe_number}}.',
                 'operator', false)`,
        [organizationId]
      );
    },
  },
  {
    slug: "procedure-awaiting-review",
    seed: async (organizationId) => {
      await upsertInferredProcedure({
        organizationId,
        intentCategory: "fire_check_probe",
        language: "en",
        steps: [{ text: "Operator fire check — not a real procedure." }],
        derivedFromCount: 5,
      });
    },
  },
  {
    slug: "booking-unassigned",
    // Inside twelve hours, which is the branch that turns urgent — the one a
    // customer physically experiences by arriving to nobody.
    seed: async (organizationId, conversationId, contactId) => {
      const start = new Date(Date.now() + 3 * 3600_000).toISOString();
      const end = new Date(Date.now() + 4 * 3600_000).toISOString();
      await createBooking({
        organizationId,
        conversationId,
        contactId,
        employeeId: null,
        startsAt: start,
        endsAt: end,
        subject: "Operator fire check — not a real appointment",
      });
    },
    expect: (finding) =>
      finding.severity === "urgent"
        ? null
        : `an appointment three hours away with nobody attached should be urgent, got ${finding.severity}`,
  },
  {
    slug: "template-rejected",
    seed: async (organizationId) => {
      // No `body` column: this table is a MIRROR of what Meta holds, not a copy
      // of the template text — `is_approved` is Meta's answer and the body lives
      // there. Guessing otherwise is what the first version of this seed did.
      await getPool().query(
        `insert into message_templates
           (organization_id, meta_template_name, language, category, status, is_approved)
         values ($1, 'fire_check_probe', 'en', 'UTILITY', 'REJECTED', false)`,
        [organizationId]
      );
    },
  },
  {
    slug: "overdue-followup",
    seed: async (organizationId, conversationId, contactId) => {
      await createTask({
        organizationId,
        conversationId,
        contactId,
        title: "Operator fire check — not a real follow-up",
        dueAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      });
    },
  },
];

/** Operators this file does not seed, and why. Printed on every run. */
const UNCOVERED: Record<string, string> = {
  "customer-waiting": "fires in production — findings on record, most recently today",
  "booking-without-anyone": "fires on an ABSENCE of staff, which cannot be seeded by adding a row — and fires in production today for abr, juris-prime-legal and sfs-international, all three measured at 0 offerable slots with the booking tool on",
  "handover-abandoned": "fires in production",
  "schedule-stalled":
    "CANNOT be seeded here — it reads job_heartbeats through withAllTenants, which opens its own connection, so an uncommitted seed is invisible to it",
  // Same obstacle as schedule-stalled above, and the same connection. Proven
  // separately and more directly instead: a probe against production moved
  // knowledge-reindex's last_error_at to an hour ago and confirmed it fires,
  // aged it past two windows and confirmed it clears, then restored the row.
  // That covers the case this gate cannot reach -- a job still finishing on
  // schedule while throwing -- and also confirmed the finding stays SILENT for
  // the real recovered row, which is the failure mode that would have made it
  // a permanent red light.
  "job-failing":
    "CANNOT be seeded here for the same reason as schedule-stalled — job_heartbeats is read through withAllTenants on its own connection. Proven by probe against production instead: fires at 1h, clears past 36h, silent on the recovered row, restored after",
  // The two below are seedable in principle and are not seeded, for reasons
  // that are about the SEED being honest rather than about effort.
  "unowned-followup":
    "suppressed by design for a business with no staff, so seeding it against a business whose roster is empty would assert the wrong behaviour",
  "thin-knowledge":
    "counts chunks against a floor, and the probe source seeded for broken-knowledge would move that count — the two would test each other rather than themselves",
  "reengagement-candidate":
    "needs a contact quiet for 30 days, which cannot be produced without back-dating a real contact's last_message_at",
};

let failures = 0;

function report(ok: boolean, label: string, detail: string) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label} — ${detail}`);
}

/**
 * Everything a finding must have to be usable, checked rather than assumed.
 *
 * `reconcileFindings` keys on the fingerprint, so a fingerprint that varies
 * between passes produces a finding that can never be retracted and a list that
 * only grows — the exact failure the reconcile design exists to prevent, and one
 * that would be invisible until an alarm had been standing for a week.
 */
function malformed(finding: FindingInput | undefined): string | null {
  if (!finding) return "no finding was produced at all";
  if (!finding.fingerprint) return "no fingerprint — this finding could never be retracted";
  if (!finding.title?.trim()) return "empty title";
  if (!["urgent", "warn", "info"].includes(finding.severity)) return `severity ${finding.severity}`;
  if (!finding.subjectId) return "no subject";
  // The two ways an interpolated count goes wrong, and both read as a real
  // number to anybody scanning the page.
  const text = `${finding.title} ${finding.detail ?? ""}`;
  if (/undefined|NaN|\[object/.test(text)) return `unrendered value in the text: ${text.slice(0, 120)}`;
  return null;
}

async function main() {
  console.log("Operator fire check — does each alarm produce a usable finding?\n");

  const organizations = await withAllTenants("fire-check: tenant registry", () => listOrganizations());
  const org = organizations[0];
  if (!org) {
    console.error("No organizations. Nothing to check.");
    process.exitCode = 1;
    return;
  }
  console.log(`Seeding against ${org.slug}, inside a transaction that is rolled back.\n`);

  for (const testCase of CASES) {
    const slug = testCase.slug.split("/")[0];
    const operator = OPERATORS.find((candidate) => candidate.slug === slug);
    if (!operator) {
      report(false, testCase.slug, "no operator with that slug — this case is checking nothing");
      continue;
    }

    try {
      await withTenant(org.id, async () => {
        const { rows: contact } = await getPool().query<{ id: string }>(
          `insert into contacts (organization_id, wa_id, display_name)
           values ($1, $2, 'Operator fire check')
           on conflict (organization_id, wa_id) do update set display_name = excluded.display_name
           returning id`,
          [org.id, PROBE_WA_ID]
        );
        const { rows: conversation } = await getPool().query<{ id: string }>(
          `insert into conversations (organization_id, contact_id) values ($1, $2) returning id`,
          [org.id, contact[0].id]
        );

        await testCase.seed(org.id, conversation[0].id, contact[0].id);

        const found = await operator.run(org.id);
        const problem = malformed(found[0]) ?? testCase.expect?.(found[0]) ?? null;
        report(
          problem === null,
          testCase.slug,
          problem ?? `raised "${found[0].title}" (${found[0].severity})`
        );

        throw new RolledBack();
      });
    } catch (err) {
      if (!(err instanceof RolledBack)) {
        report(false, testCase.slug, `threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Prove the rollback worked rather than assuming it, the same way
  // schema-check does. A leaked probe here is a fake alarm on somebody's deck.
  const strays = await withTenant(org.id, async () => {
    const { rows } = await getPool().query<{ n: string }>(
      `select count(*)::text as n from contacts where organization_id = $1 and wa_id = $2`,
      [org.id, PROBE_WA_ID]
    );
    return Number(rows[0]?.n ?? 0);
  });
  report(strays === 0, "rollback", strays === 0 ? "no probe rows survived" : `${strays} probe contacts LEAKED`);

  console.log("\nNot covered here, and why:");
  for (const [slug, reason] of Object.entries(UNCOVERED)) {
    console.log(`  — ${slug}: ${reason}`);
  }
  const covered = new Set(CASES.map((c) => c.slug.split("/")[0]));
  const unlisted = OPERATORS.filter(
    (operator) => !covered.has(operator.slug) && !(operator.slug in UNCOVERED)
  );
  for (const operator of unlisted) {
    report(false, operator.slug, "neither covered nor listed as uncovered — this gate has drifted");
  }

  if (failures > 0) {
    console.log(`\n${failures} alarms cannot be trusted to report the thing they watch.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nPASS — every seeded alarm produced a usable finding.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
