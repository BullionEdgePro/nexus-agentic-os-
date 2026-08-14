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
} from "@nexus/db";
import { OPERATORS } from "../services/operators.js";

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
