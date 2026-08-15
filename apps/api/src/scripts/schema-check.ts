/**
 * Runs every query that has never actually run.
 *
 * Today a page shipped broken because `countReachableContacts` filtered on a
 * column that does not exist. Nothing caught it: the route 401s
 * unauthenticated so external checks looked healthy, and every test in the
 * suite reads source text, which cannot know what the schema contains. It took
 * calling the real function against the real database to find it.
 *
 * That bug is not special. It is what happens to any SQL that has never been
 * executed, and a lot of this codebase's SQL has never been executed — most of
 * the broadcast send path, and all the contact-memory writes. The send path is
 * the worst place for it to hide, because the first time it runs will be a real
 * bulk send to real customers.
 *
 * So this exercises those paths end to end, against production data, and
 * changes nothing:
 *
 *   * Reads run as-is.
 *   * Writes run against a probe contact created for the purpose and deleted
 *     afterwards, in a `finally` so a failure mid-way still cleans up.
 *   * The broadcast path stops before enqueueing. Rows are created, read back
 *     and removed; no job is queued and no message is sent. Proving the SQL
 *     works must not cost a customer a WhatsApp message.
 *
 * Run: docker exec -w /app/apps/api nexus-api-1 npx tsx src/scripts/schema-check.ts
 */

import {
  listOrganizations,
  withTenant,
  withAllTenants,
  getPool,
  getBrainStatus,
  getBroadcastTemplate,
  listBroadcastTemplates,
  createBroadcast,
  getBroadcast,
  getContactsForAudience,
  createBroadcastRecipients,
  updateBroadcastStatus,
  updateBroadcastRecipientStatus,
  isBroadcastFullyProcessed,
  upsertContactMemory,
  getContactMemory,
  forgetContact,
  purgeExpiredContactMemory,
  createTask,
  listTasks,
  countTasks,
  completeTask,
  listOpenTasksForContact,
  reconcileFindings,
  createBooking,
  listBookings,
  listBookingsForConversation,
  listUpcomingBookingsForContact,
  countBookings,
  setBookingStatus,
  assignBooking,
  listProcedures,
  countProcedures,
  getProcedure,
  upsertInferredProcedure,
  setProcedureActive,
  acceptProposal,
  dismissProcedureSuggestion,
  replaceProcedureSteps,
  createOperatorProcedure,
  getActiveProcedure,
  rollUpProcedureOutcomes,
  recordConversationMetric,
} from "@nexus/db";
import { OPERATORS } from "../services/operators.js";
import {
  findWellHandledConversations,
  getInferenceReadiness,
} from "../services/procedure-inference.js";

/** Deliberately implausible, and the same shape self-check.ts already uses. */
const PROBE_WA_ID = "999000000000002";

/**
 * Constants, so cleanup can find the debris without depending on a variable
 * that a failure may have prevented from being assigned. See the `finally`
 * block for the run where that distinction mattered.
 */
const PROBE_TASK_TITLE = "Schema check probe — not real work";
const PROBE_OPERATOR = "schema-check-probe";
const PROBE_BOOKING_SUBJECT = "Schema check probe — not a real appointment";

let failures = 0;

async function step<T>(label: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await run();
    console.log(`  ok    ${label}`);
    return result;
  } catch (err) {
    failures++;
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  FAIL  ${label.padEnd(34)} ${message.slice(0, 100)}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  console.log("Schema check — every query that has never run\n");

  const organizations = await withAllTenants("schema-check: pick a tenant", () => listOrganizations());
  const org = organizations.find((o) => o.slug === "zipicka") ?? organizations[0];
  if (!org) {
    console.error("No active organizations.");
    process.exit(1);
  }
  console.log(`Using ${org.slug}\n`);

  console.log("Reads");
  await withAllTenants("schema-check: brain status", () => step("brain status", () => getBrainStatus()));

  const templates = await withTenant(org.id, () => listBroadcastTemplates(org.id));
  const template = templates[0];
  if (template) {
    await withTenant(org.id, () =>
      step("broadcast template lookup", () => getBroadcastTemplate(template.id))
    );
  } else {
    console.log("  skip  broadcast template lookup    (no templates registered)");
  }

  // ---- operators ----
  //
  // EVERY OPERATOR IS HAND-WRITTEN SQL AND NOTHING PLANNED IT UNTIL A SWEEP RAN.
  //
  // `judge-offline` shipped with `created_at` on a table whose column is
  // `evaluated_at`. It threw on all five businesses on its first sweep — caught,
  // but ten minutes after deploying, in a background queue whose failures live
  // in the log. This is precisely the class this script exists for: SQL that
  // only fails when Postgres plans it.
  //
  // Read-only, so they can be run against the real tenant with no probe and no
  // cleanup. Running them here does not replace the sweep; it moves the
  // discovery to the moment somebody is watching.
  console.log("\nOperators (read-only, run against a real tenant)");
  for (const operator of OPERATORS) {
    await withTenant(org.id, () => step(`operator ${operator.slug}`, () => operator.run(org.id)));
  }

  // ---- procedural memory (migrations 033 and 034) ----
  //
  // Every query in packages/db/procedures.ts and in the inference writer is new,
  // which by this script's own premise makes all of them unverified. The shapes
  // with something to get wrong are the ones that have bitten here before: two
  // CTEs joined on conversation_id, an aggregate with three `filter` clauses,
  // and four guarded updates.
  //
  // THE WRITES RUN INSIDE A TRANSACTION THAT IS DELIBERATELY ROLLED BACK, which
  // is a different technique from the probe-and-delete used everywhere else in
  // this file — and it is forced by the design rather than chosen for elegance.
  // Migrations 033 and 034 grant no DELETE on `procedures` to the application
  // role, because a procedure that was once active is the record of how a
  // business answered its customers for a while. So a probe row here could not
  // be cleaned up: it would sit on the review screen forever, looking like a
  // real suggestion somebody had to rule on.
  //
  // Postgres plans and executes every statement below regardless; the rollback
  // only discards the result. That is the whole point of running them.
  console.log("\nProcedural memory (F10)");

  await withTenant(org.id, async () => {
    await step("well-handled conversations", () => findWellHandledConversations(org.id));
    await step("inference readiness", () => getInferenceReadiness(org.id));
    await step("list procedures", () => listProcedures(org.id));
    await step("count procedures", () => countProcedures(org.id));
  });

  class RolledBack extends Error {}
  const PROBE_INTENT = "schema_check_probe";
  const probeSteps = [{ text: "Schema check probe — not a real procedure" }];

  try {
    await withTenant(org.id, async () => {
      const created = await step("infer a procedure", () =>
        upsertInferredProcedure({
          organizationId: org.id,
          intentCategory: PROBE_INTENT,
          language: "en",
          steps: probeSteps,
          derivedFromCount: 5,
        })
      );

      if (created?.outcome !== "created") {
        console.log(`  FAIL  the inferred row is created      (outcome=${created?.outcome})`);
        failures++;
      } else {
        console.log("  ok    the inferred row is created");
      }

      const id = created?.procedureId;
      if (id) {
        // Off by default is the whole restraint of this feature. Asserted on the
        // row as READ BACK, not on the default in the migration — those are two
        // different claims and only this one is about what happened.
        const readBack = await getProcedure(org.id, id);
        if (readBack?.isActive === false && readBack.source === "inferred") {
          console.log("  ok    it arrives switched off and marked inferred");
        } else {
          console.log("  FAIL  it arrives switched off          (a procedure activated itself)");
          failures++;
        }

        await step("activate", () => setProcedureActive(org.id, id, true, "schema-check"));

        // With it active, a differing inference must become a PROPOSAL rather
        // than an edit. This is the property the whole review model rests on.
        const second = await step("re-infer while active", () =>
          upsertInferredProcedure({
            organizationId: org.id,
            intentCategory: PROBE_INTENT,
            language: "en",
            steps: [...probeSteps, { text: "A second step, so the inference differs" }],
            derivedFromCount: 6,
          })
        );
        const afterSecond = await getProcedure(org.id, id);
        if (second?.outcome === "proposed" && afterSecond?.steps.length === 1) {
          console.log("  ok    an active procedure is proposed to, not rewritten");
        } else {
          console.log(
            `  FAIL  an active procedure is not rewritten (outcome=${second?.outcome}, steps=${afterSecond?.steps.length})`
          );
          failures++;
        }

        await step("accept the proposal", () => acceptProposal(org.id, id, "schema-check"));
        await step("dismiss a suggestion", () =>
          dismissProcedureSuggestion(org.id, id, "schema-check")
        );
        await step("edit by hand", () =>
          replaceProcedureSteps(org.id, id, probeSteps, "schema-check")
        );
        await step("deactivate", () => setProcedureActive(org.id, id, false, "schema-check"));
      }

      // ---- the half that speaks (migration 036) ----
      //
      // Every query below is new and none had ever been planned: the live
      // reply-path lookup, the metric insert now carrying `procedure_id`, and
      // the rollup that derives both counters from it. The reply-path one is
      // the dangerous member of that set — a break there is not a page that
      // fails to load, it is the agent path throwing on live customer traffic.
      if (id) {
        await step("reply path finds the active procedure", async () => {
          await setProcedureActive(org.id, id, true, "schema-check");
          const found = await getActiveProcedure(org.id, PROBE_INTENT);
          if (found?.id !== id) throw new Error("an active procedure was not found by the reply path");
          return found;
        });

        // A stamped metric row, so the rollup has something real to count. The
        // conversation and contact are created here and discarded with
        // everything else when this transaction rolls back.
        const stamped = await step("stamp a reply with the procedure", async () => {
          const { rows: c } = await getPool().query<{ id: string }>(
            `insert into contacts (organization_id, wa_id, display_name)
             values ($1, $2, 'Schema check probe')
             on conflict (organization_id, wa_id) do update set display_name = excluded.display_name
             returning id`,
            [org.id, PROBE_WA_ID]
          );
          const { rows: conv } = await getPool().query<{ id: string }>(
            `insert into conversations (organization_id, contact_id) values ($1, $2) returning id`,
            [org.id, c[0].id]
          );
          await recordConversationMetric({
            organizationId: org.id,
            conversationId: conv[0].id,
            intent: "knowledge_lookup",
            resolvedBy: "ai_agent",
            inputTokens: 1,
            outputTokens: 1,
            procedureId: id,
          });
          return conv[0].id;
        });

        if (stamped) {
          await step("recompute procedure outcomes", () => rollUpProcedureOutcomes(org.id));
          const counted = await getProcedure(org.id, id);
          // Applied is 1 — the procedure shaped a reply. Contained is 0,
          // because this probe conversation has no messages and therefore
          // cannot meet the "nobody stepped in and the customer came back"
          // bar. That asymmetry is the point of the LEFT join in the rollup:
          // the two numbers answer two different questions.
          if (counted?.timesApplied === 1 && counted.timesSucceeded === 0) {
            console.log("  ok    applied counts the reply, contained does not assume it went well");
          } else {
            console.log(
              `  FAIL  outcomes are derived correctly (applied=${counted?.timesApplied}, contained=${counted?.timesSucceeded})`
            );
            failures++;
          }
        }

        await setProcedureActive(org.id, id, false, "schema-check");
      }

      // Written by hand, which is the other insert and takes the other branch of
      // the unique-index catch.
      await step("write one by hand", () =>
        createOperatorProcedure({
          organizationId: org.id,
          intentCategory: `${PROBE_INTENT}_operator`,
          language: "en",
          steps: probeSteps,
          activate: false,
          reviewedBy: "schema-check",
        })
      );

      throw new RolledBack();
    });
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
  }

  // Prove the rollback worked rather than assuming it. If it did not, a probe
  // procedure is now sitting on somebody's review screen — and unlike every
  // other probe in this file, nothing in the application can remove it.
  const strays = await withTenant(org.id, async () => {
    const { rows } = await getPool().query<{ n: string }>(
      `select count(*)::text as n
         from procedures
        where organization_id = $1 and intent_category like $2`,
      [org.id, `${PROBE_INTENT}%`]
    );
    return Number(rows[0]?.n ?? 0);
  });
  if (strays === 0) {
    console.log("  ok    the probe procedures were rolled back");
  } else {
    console.log(`  FAIL  probe procedures survived (${strays}) — they cannot be deleted`);
    failures++;
  }

  // ---- writes, against a probe that is always removed ----
  console.log("\nWrites (probe row, cleaned up)");
  let contactId: string | undefined;
  let broadcastId: string | undefined;

  try {
    await withTenant(org.id, async () => {
      const { rows } = await getPool().query<{ id: string }>(
        `insert into contacts (organization_id, wa_id, display_name)
         values ($1, $2, 'Schema check probe')
         on conflict (organization_id, wa_id) do update set display_name = excluded.display_name
         returning id`,
        [org.id, PROBE_WA_ID]
      );
      contactId = rows[0]?.id;
    });

    if (!contactId) {
      console.log("  FAIL  probe contact                 could not be created");
      failures++;
    } else {
      const id = contactId;

      await withTenant(org.id, async () => {
        await step("upsert contact memory", () =>
          upsertContactMemory({
            organizationId: org.id,
            contactId: id,
            summary: "Schema check probe. Not a real customer.",
            sourceMessages: 4,
          })
        );

        // Asserting the row is READABLE, not merely that the write did not
        // throw. A write that succeeds and a read that returns nothing is the
        // failure this whole session keeps meeting.
        const memory = await getContactMemory(org.id, id);
        if (memory?.summary?.startsWith("Schema check probe")) {
          console.log("  ok    contact memory reads back");
        } else {
          console.log("  FAIL  contact memory reads back     wrote, but read returned nothing");
          failures++;
        }

        await step("forget contact", () => forgetContact(org.id, id));
        await step("purge expired memory", () => purgeExpiredContactMemory());
      });

      // ---- the broadcast path, stopping short of enqueueing ----
      if (template) {
        await withTenant(org.id, async () => {
          const broadcast = await step("create broadcast (draft)", () =>
            createBroadcast({ organizationId: org.id, templateId: template.id, audienceFilter: {} })
          );
          broadcastId = broadcast?.id;

          if (broadcastId) {
            const bid = broadcastId;
            await step("read broadcast back", () => getBroadcast(bid));
            const contacts = await step("resolve audience", () =>
              getContactsForAudience(org.id, {})
            );

            if (contacts && contacts.length > 0) {
              const recipients = await step("create recipients", () =>
                createBroadcastRecipients(bid, [contacts[0].id])
              );
              if (recipients?.[0]) {
                await step("mark recipient sent", () =>
                  updateBroadcastRecipientStatus(recipients[0].id, "sent")
                );
                await step("check completion", () => isBroadcastFullyProcessed(bid));
              }
            } else {
              console.log("  skip  create recipients             (no contacts)");
            }

            await step("update broadcast status", () => updateBroadcastStatus(bid, "completed"));
          }
        });
      } else {
        console.log("  skip  broadcast path                (no templates registered)");
      }

      // ---- follow-ups (migration 025) ----
      //
      // Every query in packages/db/tasks.ts is new, which by this script's own
      // premise means every one of them is unverified. The three below are the
      // ones with something to get wrong: a CTE returning through a join, an
      // aggregate with three `filter` clauses, and a guarded update.
      await withTenant(org.id, async () => {
        const created = await step("create task", () =>
          createTask({
            organizationId: org.id,
            contactId: id,
            title: PROBE_TASK_TITLE,
            dueAt: new Date(Date.now() + 3_600_000).toISOString(),
          })
        );
        if (created) {

          // The insert returns through TASK_SELECT's joins. If the business
          // join were wrong the row would come back with a null name rather
          // than an error, and the page would show a task belonging to nobody.
          if (!created.businessName) {
            console.log("  FAIL  task returns its business    (null business_name)");
            failures++;
          } else {
            console.log("  ok    task returns its business");
          }

          await step("list tasks", () => listTasks({ organizationId: org.id }));
          await step("count tasks", () => countTasks(org.id));

          // The reply-path lookup. This one runs on every inbound customer
          // message, so a broken query here would not be a page that fails to
          // load — it would be the agent path throwing on live traffic.
          const owed = await step("open follow-ups for a contact", () =>
            listOpenTasksForContact(org.id, id)
          );
          if (owed && !owed.some((task) => task.id === created.id)) {
            console.log("  FAIL  the probe follow-up is findable  (created but not returned)");
            failures++;
          } else if (owed) {
            console.log("  ok    the probe follow-up is findable");
          }

          // ---- operator reconciliation (migration 027) ----
          //
          // The property the whole feature rests on, exercised end to end
          // against the real schema: raise a finding, confirm it stands, then
          // report an empty set and confirm it is RETRACTED. A reconcile that
          // could only open would build a list that grows forever, and nobody
          // would notice until they had stopped reading it.
          const raised = await step("operator raises a finding", () =>
            reconcileFindings(org.id, PROBE_OPERATOR, [
              {
                fingerprint: `probe-${created.id}`,
                severity: "info",
                title: "Schema check probe — not a real finding",
                subjectKind: "task",
                subjectId: created.id,
              },
            ])
          );
          if (raised && raised.standing !== 1) {
            console.log(`  FAIL  the finding stands              (standing=${raised.standing})`);
            failures++;
          } else if (raised) {
            console.log("  ok    the finding stands");
          }

          const cleared = await step("operator retracts on an empty set", () =>
            reconcileFindings(org.id, PROBE_OPERATOR, [])
          );
          if (cleared && cleared.retracted !== 1) {
            console.log(
              `  FAIL  an empty set retracts it        (retracted=${cleared.retracted}) — findings would accumulate forever`
            );
            failures++;
          } else if (cleared) {
            console.log("  ok    an empty set retracts it");
          }

          const done = await step("complete task", () => completeTask(created.id));
          // completeTask is guarded on `status = 'open'`, so a second call must
          // return null rather than overwriting the completion record.
          const again = await completeTask(created.id).catch(() => null);
          if (done && again === null) {
            console.log("  ok    completing twice is refused");
          } else {
            console.log("  FAIL  completing twice is refused  (second call changed the row)");
            failures++;
          }
        }

        // ---- appointments (migrations 031 and 032) ----
        //
        // Every query in packages/db/bookings.ts is new, and one of them runs
        // on the live reply path the moment a customer with an appointment
        // writes back. By this script's own premise that makes all of them
        // unverified — and the ones with something to get wrong are the same
        // shapes that already bit once here: an insert returning through three
        // joins, an aggregate with three `filter` clauses, and two guarded
        // updates.
        //
        // The probe is left UNASSIGNED on purpose. `bookings_no_double_booking`
        // only covers rows naming an employee, so the clash cannot be exercised
        // without one — and creating an employee here would make this script
        // something other than what it says it is. That round-trip belongs in
        // self-check, which already keeps a reserved probe employee, and this
        // stops at "does the SQL plan and return what it claims".
        const startsAt = new Date(Date.now() + 26 * 3_600_000);
        const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
        const booked = await step("create booking", () =>
          createBooking({
            organizationId: org.id,
            contactId: id,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            subject: PROBE_BOOKING_SUBJECT,
          })
        );
        if (booked) {
          // The insert returns through BOOKING_SELECT's joins, one of which is
          // an INNER join to contacts. A wrong join condition would return no
          // row rather than an error — and `rows[0]` would then be undefined,
          // which is the loud version. A wrong business join returns a row with
          // a null name, which is the quiet one, so it is checked by name.
          if (!booked.businessName || !booked.businessTimezone) {
            console.log("  FAIL  booking returns its business (null name or timezone)");
            failures++;
          } else {
            console.log("  ok    booking returns its business");
          }

          await step("list bookings", () => listBookings({ organizationId: org.id }));
          await step("count bookings", () => countBookings(org.id));
          await step("bookings for a conversation", () => listBookingsForConversation(booked.id));

          // The reply-path lookup. A break here is not a page that fails to
          // load — it is the agent path throwing on live customer traffic.
          const upcoming = await step("upcoming bookings for a contact", () =>
            listUpcomingBookingsForContact(org.id, id)
          );
          if (upcoming && !upcoming.some((b) => b.id === booked.id)) {
            console.log("  FAIL  the probe booking is findable   (created but not returned)");
            failures++;
          } else if (upcoming) {
            console.log("  ok    the probe booking is findable");
          }

          // Reassignment to nobody. Exercises assignBooking's own query without
          // needing an employee — the branch that validates one is covered in
          // self-check, where a real probe employee exists.
          await step("unassign booking", () => assignBooking(booked.id, null));

          const cancelledBooking = await step("cancel booking", () =>
            setBookingStatus(booked.id, "cancelled")
          );
          // Guarded on `status <> $2`, so a second cancel must return null
          // rather than restamping the row. Same property completeTask has, and
          // the same reason: a repeated click must not rewrite history.
          const cancelAgain = await setBookingStatus(booked.id, "cancelled").catch(() => null);
          if (cancelledBooking?.status === "cancelled" && cancelAgain === null) {
            console.log("  ok    cancelling twice is refused");
          } else {
            console.log("  FAIL  cancelling twice is refused  (second call changed the row)");
            failures++;
          }
        }
      });
    }
  } finally {
    // Cleanup in a finally, so a failure above still leaves production as it
    // was found. Recipients cascade from the broadcast; memory cascades from
    // the contact.
    await withTenant(org.id, async () => {
      // Deleted BY TITLE, not by the id this run happens to hold.
      //
      // The earlier version cleaned up `where id = $1` using taskId — which is
      // only assigned once createTask RETURNS. On 2026-08-12 createTask threw
      // after its INSERT had already committed (a data-modifying CTE cannot see
      // its own write, so the row existed while the function raised), taskId
      // stayed undefined, and the probe was never cleaned up. It sat in
      // production for hours and was eventually found by an operator reporting
      // it as a real overdue commitment.
      //
      // The lesson is general: cleanup keyed on a variable that a failure
      // prevents from being set is cleanup that skips exactly when it is
      // needed. The title is a constant, so it survives any failure above.
      //
      // Still explicit rather than relying on the contact cascade, because a
      // task's contact_id is `on delete set null` by design — a follow-up must
      // outlive what it points at.
      await getPool()
        .query(`delete from tasks where organization_id = $1 and title = $2`, [org.id, PROBE_TASK_TITLE])
        .catch(() => undefined);
      // By SUBJECT, not by the id this run happens to hold — the same lesson
      // the task cleanup above is written around. `createBooking` can throw
      // after its INSERT has committed (SlotTakenError is raised from the catch,
      // and a data-modifying CTE cannot see its own write), which leaves the
      // returned id undefined while the row exists. A probe appointment left in
      // production is worse than a probe task: it shows up in the diary as a
      // real customer somebody is expected to meet.
      await getPool()
        .query(`delete from bookings where organization_id = $1 and subject = $2`, [
          org.id,
          PROBE_BOOKING_SUBJECT,
        ])
        .catch(() => undefined);
      // Any findings raised about it go too, by the same argument.
      await getPool()
        .query(`delete from operator_findings where organization_id = $1 and operator = $2`, [
          org.id,
          PROBE_OPERATOR,
        ])
        .catch(() => undefined);
      if (broadcastId) {
        await getPool()
          .query(`delete from broadcasts where id = $1`, [broadcastId])
          .catch(() => undefined);
      }
      await getPool()
        .query(`delete from contacts where organization_id = $1 and wa_id = $2`, [org.id, PROBE_WA_ID])
        .catch(() => undefined);
    });

    // Prove the cleanup worked rather than assuming it. A probe left behind
    // becomes a fake customer in someone's audience count.
    const leftover = await withTenant(org.id, async () => {
      const { rows } = await getPool().query<{ n: string }>(
        `select (
           (select count(*) from contacts where organization_id = $1 and wa_id = $2)
           -- Counted separately even though contact_id cascades, because a
           -- probe appointment is the worst debris this script can leave: it
           -- appears in the diary as a real customer somebody is expected to
           -- meet, and it holds a slot the constraint will refuse to anybody
           -- else.
           + (select count(*) from bookings where organization_id = $1 and subject = $3)
         )::text as n`,
        [org.id, PROBE_WA_ID, PROBE_BOOKING_SUBJECT]
      );
      return Number(rows[0]?.n ?? 0);
    });
    console.log(
      leftover === 0 ? "\n  ok    probe removed" : `\n  FAIL  probe still present (${leftover})`
    );
    if (leftover !== 0) failures++;
  }

  console.log(
    failures === 0
      ? "\nPASS — every previously-unrun query works against the real schema.\n"
      : `\nFAIL — ${failures} problem(s) above. These are queries that would have failed the first time a customer triggered them.\n`
  );

  await getPool().end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
