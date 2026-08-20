/**
 * Can a business answer its own customers, from inside the OWNER's transaction?
 *
 *   docker compose -f docker-compose.prod.yml exec -T worker \
 *     npx tsx apps/api/src/scripts/shared-number-check.ts
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * The same defect has now been found SIX times, and every time it was found
 * after it had already cost something:
 *
 *   1. `hasStaffOnShift` answered "you have no staff at all" for four of five
 *      businesses, so escalation promised a specialist who was never told.
 *   2. The phrase lookup returned the platform default instead of a business's
 *      own authored wording.
 *   3. The stale-handoff release could never fire on a shared number, leaving
 *      four conversations muted for sixteen days.
 *   4. `loadActiveAgentConfig` returned nothing, so a customer who chose a
 *      business from the triage menu got NO REPLY AT ALL for seventeen hours.
 *   5. `searchKnowledge` returned nothing, so a routed customer's every question
 *      would have been answered "I'll check with a colleague".
 *   6. `hasActiveEmployees` returned false, so the stale-handoff release would
 *      have decided a human's conversation was abandoned and let the agent talk
 *      over them. Found before it fired, and only because #3 fixed the argument
 *      to this same call and a test locked it — proving the argument right is
 *      not proving the question right.
 *
 * The mechanism is identical each time. Migration 010 put all five businesses on
 * Zipicka's WhatsApp number. Every inbound message therefore runs inside a
 * transaction scoped to the NUMBER'S OWNER, while the thing being read belongs
 * to the SERVING business. Under RLS that is not an error — it is ZERO ROWS,
 * which every caller correctly reads as "this business has nothing configured".
 *
 * Nothing in the existing gates could catch it. `rls-verify` proves a tenant
 * cannot see another tenant's rows, which is the property working AS DESIGNED
 * here. `retrieval-check` and `self-check` scope themselves to each business
 * directly, which is the one context in which the bug is invisible.
 *
 * ============================================================
 * WHAT IT ACTUALLY DOES
 * ============================================================
 *
 * For each business sharing the owner's number, every probe below is run twice:
 * once scoped to that business (the truth), and once through the reply path's
 * real shape — a transaction scoped to the OWNER, asking for the serving
 * business. If the second answer is emptier than the first, the widening is
 * missing and a customer of that business is being told nothing.
 *
 * Comparing the two is the whole design. An absolute assertion ("juris-prime
 * must have knowledge") would fail for a business that genuinely has none, and
 * pass for one whose data is real but unreachable. The difference between the
 * two reads is exactly the bug and nothing else.
 */
import { pathToFileURL } from "node:url";
import {
  withTenant,
  withAllTenants,
  listOrganizations,
  findNumberOwner,
  getPool,
  getActivePhrase,
  getActiveProcedure,
  listOpenTasksForContact,
  hasActiveEmployees,
  listBookingsInWindow,
} from "@nexus/db";
import { routeToEmployeeTwin } from "@nexus/agents";
import { searchKnowledgeLexical } from "@nexus/knowledge";
import { hasStaffOnShift } from "../services/availability.js";
import type { Organization } from "@nexus/shared";

/**
 * One thing the reply path reads about the business that is answering.
 *
 * `count` returns a number rather than a boolean so the failure message can say
 * how much went missing — "0 where 91 exist" is a report somebody can act on,
 * "false" is not.
 */
interface Probe {
  name: string;
  /** What broke, in customer terms, when this one was wrong. */
  consequence: string;
  count: (serving: Organization) => Promise<number>;
}

const PROBES: Probe[] = [
  {
    name: "agent config",
    consequence: "the customer receives nothing at all",
    count: async (serving) => ((await routeToEmployeeTwin(serving, null)) ? 1 : 0),
  },
  {
    name: "knowledge retrieval",
    consequence: "every answer becomes 'I'll check with a colleague'",
    // Through the LEXICAL search rather than a hand-written count.
    //
    // That distinction is the difference between this gate working and this
    // gate being theatre. The first version of this probe counted
    // `knowledge_chunks` with a raw query, and it failed for all four
    // businesses even after the bug was fixed — because a raw read is not the
    // application's read, and all it measured was that RLS is switched on,
    // which is by design. A probe has to call the function the reply path calls,
    // or it can only ever re-measure the policy.
    //
    // Lexical rather than semantic because it costs no embedding request and
    // cannot fail on a provider outage, while running the identical
    // VISIBILITY_SQL under the identical scoping.
    //
    // THE QUERY IS A BAG OF CONTENT WORDS, and the first attempt was "the",
    // which returned nothing for every business — `to_tsvector('english', …)`
    // drops stopwords, so the query became empty and matched no row anywhere.
    // The gate passed and reported "0 either way — proves nothing yet" on the
    // one probe it most needed to prove, which is a check that cannot fail
    // wearing the word ok. Terms are OR-ed, so any corpus here matches at least
    // one of these, and matching is all this asks about.
    count: async (serving) =>
      (
        await searchKnowledgeLexical({
          organizationId: serving.id,
          query: "service contact price document property delivery legal",
          limit: 5,
        })
      ).length,
  },
  {
    name: "staff on shift",
    consequence: "escalation promises a specialist nobody told",
    count: async (serving) => ((await hasStaffOnShift(serving.id)) ? 1 : 0),
  },
  {
    name: "authored wording",
    consequence: "the business's own sentence is replaced by the platform default",
    count: async (serving) => ((await getActivePhrase(serving.id, "handing_over")) ? 1 : 0),
  },
  {
    name: "open follow-ups",
    consequence: "a promise made to this customer never reaches the agent",
    // Through the reply path's own reader, against a contact id that cannot
    // exist. What is being measured is whether the QUERY runs in the right
    // scope, and an empty result from a real contact would be
    // indistinguishable from an empty result from the wrong tenant.
    count: async (serving) =>
      (await listOpenTasksForContact(serving.id, ABSENT_CONTACT)).length,
  },
  {
    name: "handoff release",
    consequence: "the agent talks over a human who had taken the conversation",
    // A SEPARATE PROBE FROM "staff on shift", because they are separate
    // functions and only one of them was widened.
    //
    // `hasStaffOnShift` reads presence and was fixed on 2026-08-17.
    // `hasActiveEmployees` reads the rota, is asked by the stale-handoff
    // release, and was still raw SQL two days later. Both answer "can anyone
    // here take this", which is what made the gap invisible: the probe for one
    // passed and the reader beside it was untouched.
    //
    // Its failure direction is the opposite of every other probe here, and
    // worse. The others return nothing and the customer is told nothing. This
    // one returns FALSE — "this business has no staff at all" — and the
    // pipeline acts on it by releasing a handoff a human is holding.
    count: async (serving) => ((await hasActiveEmployees(serving.id)) ? 1 : 0),
  },
  {
    name: "the diary",
    consequence: "the agent offers an appointment slot somebody already has",
    // THE ONLY PROBE HERE WHOSE FAILURE DIRECTION IS A FALSE POSITIVE.
    //
    // Every other read on this list goes empty and the customer is told
    // nothing. This one goes empty and the customer is told YES: an unwidened
    // diary read returns no existing bookings, which does not look like an
    // error, it looks like a free afternoon. The agent then offers a slot that
    // is taken.
    //
    // Counting bookings in a window wide enough to include whatever is in the
    // diary. Zero either way is reported as proving nothing, same as the rest —
    // four of these businesses have never taken a booking.
    count: async (serving) =>
      (
        await listBookingsInWindow(
          serving.id,
          new Date(Date.now() - 90 * 86_400_000),
          new Date(Date.now() + 90 * 86_400_000)
        )
      ).length,
  },
  {
    name: "active procedures",
    consequence: "the business's own method never shapes a reply",
    count: async (serving) =>
      (await getActiveProcedure(serving.id, "knowledge_lookup")) ? 1 : 0,
  },
];

/**
 * A contact id belonging to nobody.
 *
 * `listOpenTasksForContact` needs one, and using a real customer's would make
 * this gate depend on that customer still existing. All zeroes is a valid uuid
 * and matches nothing, so both reads return an empty list — which is the
 * correct outcome, and the probe is still exercising the scope that read ran in.
 */
const ABSENT_CONTACT = "00000000-0000-0000-0000-000000000000";

let failures = 0;

function report(ok: boolean, label: string, detail: string) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label} — ${detail}`);
}

async function main() {
  console.log("Shared number — can a serving business be read from the owner's transaction?\n");

  const organizations = await withAllTenants("shared-number-check: tenant registry", () =>
    listOrganizations()
  );

  // The owner is whichever business the WhatsApp number is REGISTERED to, and
  // that is a column rather than an ordering.
  //
  // This gate used to take the first entry of each group, and `listOrganizations`
  // orders by NAME — so it called ABR the owner and said so in its own output,
  // while all fourteen of the platform's conversations are filed under Zipicka.
  // It still exercised the widening, because `withServingTenant` widens the same
  // way between any two businesses on one number; what it did not exercise was
  // the direction production actually takes, and it printed something untrue
  // about the platform every time it ran.
  const byNumber = new Map<string, Organization[]>();
  for (const organization of organizations) {
    const number = organization.whatsappPhoneNumberId;
    if (!number) continue;
    byNumber.set(number, [...(byNumber.get(number) ?? []), organization]);
  }

  const shared = [...byNumber.values()].filter((group) => group.length > 1);
  if (shared.length === 0) {
    console.log("No number is shared by more than one business. Nothing to check.");
    return;
  }

  for (const group of shared) {
    // Every business on the number takes a turn as the owner's transaction,
    // because the pipeline's scope comes from `findOrganizationByPhoneNumberId`
    // and any of them could be what that returns.
    const owner = await withAllTenants("shared-number-check: number owner", () =>
      findNumberOwner(group[0].whatsappPhoneNumberId)
    );
    if (!owner) {
      report(false, group[0].whatsappPhoneNumberId, "no business on this number is flagged is_number_owner");
      continue;
    }
    const serving = group.filter((business) => business.id !== owner.id);
    console.log(`${owner.slug} owns the number; ${serving.length} businesses answer on it\n`);

    for (const business of serving) {
      console.log(`  ${business.slug}`);

      for (const probe of PROBES) {
        // The truth: read as the business itself.
        const direct = await withTenant(business.id, () => probe.count(business)).catch(() => -1);
        // The reply path's real shape: the owner's transaction, the serving
        // business's data.
        const asOwner = await withTenant(owner.id, () => probe.count(business)).catch(() => -1);

        if (direct < 0 || asOwner < 0) {
          report(false, probe.name, "the probe itself threw — this is not a scope result");
          continue;
        }

        if (asOwner < direct) {
          report(
            false,
            probe.name,
            `${asOwner} visible from ${owner.slug}'s transaction, ${direct} exist — ${probe.consequence}`
          );
          continue;
        }

        // Equal counts with nothing to see is not evidence of anything, and
        // saying so is the difference between a passing check and a check that
        // cannot fail. Four of these businesses have never had a customer.
        report(
          true,
          probe.name,
          direct === 0 ? `nothing to read (0 either way — proves nothing yet)` : `${direct} visible either way`
        );
      }
      console.log("");
    }
  }

  if (failures > 0) {
    console.log(`${failures} reads return less inside the owner's transaction than outside it.`);
    console.log("On this platform that is not a permissions question — it is a customer being told nothing.");
    console.log("The fix is withServingTenant at the read, not at the call site. See switchboard.ts.");
    process.exitCode = 1;
    return;
  }
  console.log("PASS — every serving business is fully readable from the owner's transaction.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
