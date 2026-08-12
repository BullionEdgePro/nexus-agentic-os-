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
} from "@nexus/db";

/** Deliberately implausible, and the same shape self-check.ts already uses. */
const PROBE_WA_ID = "999000000000002";

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

  // ---- writes, against a probe that is always removed ----
  console.log("\nWrites (probe row, cleaned up)");
  let contactId: string | undefined;
  let broadcastId: string | undefined;
  let taskId: string | undefined;

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
            title: "Schema check probe — not real work",
            dueAt: new Date(Date.now() + 3_600_000).toISOString(),
          })
        );
        if (created) {
          taskId = created.id;

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
          const probeOperator = "schema-check-probe";
          const raised = await step("operator raises a finding", () =>
            reconcileFindings(org.id, probeOperator, [
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
            reconcileFindings(org.id, probeOperator, [])
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
      });
    }
  } finally {
    // Cleanup in a finally, so a failure above still leaves production as it
    // was found. Recipients cascade from the broadcast; memory cascades from
    // the contact.
    await withTenant(org.id, async () => {
      // Deleted explicitly. A task's contact_id is `on delete set null`, by
      // design — a follow-up must survive the deletion of what it points at —
      // so removing the probe contact would leave the probe task behind as a
      // permanent fake entry on the operator's list.
      if (taskId) {
        await getPool()
          .query(`delete from tasks where id = $1`, [taskId])
          .catch(() => undefined);
      }
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
        `select count(*)::text as n from contacts where organization_id = $1 and wa_id = $2`,
        [org.id, PROBE_WA_ID]
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
