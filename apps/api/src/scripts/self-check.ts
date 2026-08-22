/**
 * Exercise the live system against the live database.
 *
 *   docker compose -f docker-compose.prod.yml exec -T worker \
 *     npx tsx apps/api/src/scripts/self-check.ts
 *
 * Not a test suite — the unit tests already cover the pure logic, and they pass
 * whether or not the SQL underneath matches the real schema. This runs the
 * actual queries against the actual columns, which is the one thing a test with
 * a mocked pool structurally cannot do. The employee layer had never executed
 * against production when this was written; a `ct.name` that should have been
 * `ct.display_name` would have surfaced the first time an operator clicked
 * something, not before.
 *
 * Read-mostly. It creates exactly one employee, under a reserved code, and
 * removes it before exiting — including on failure.
 */
import { pathToFileURL } from "node:url";
import { PHRASE_MOMENTS, unfilledPlaceholders } from "@nexus/shared";
import {
  getPool,
  withTenant,
  withAllTenants,
  withoutTenant,
  findOrganizationBySlug,
  listOrganizations,
  createEmployee,
  findEmployeeById,
  listEmployees,
  deactivateEmployee,
  setEmployeeAccessCodeHash,
  findEmployeeForLogin,
  recordEmployeeLogin,
  listConversationsForEmployee,
  findSharedNumberBusinesses,
  getDisplayNumbers,
  createBooking,
  setBookingStatus,
  findNumberOwner,
  getActivePhrase,
  listUpcomingBookingsForContact,
  SlotTakenError,
} from "@nexus/db";
import {
  generateAccessCode,
  hashAccessCode,
  verifyAccessCode,
  buildDirectContact,
  resolvePresence,
} from "@nexus/employees";
import { classifyBusiness, buildDeepLink, findAvailableSlots,
  checkAvailabilityTool,
  bookAppointmentTool,
} from "@nexus/agents";
import { captureEmployeeLead, listEmployeeLeads } from "@nexus/leads";
import { searchKnowledge } from "@nexus/knowledge";

// Reserved so a self-check can never collide with a real person.
const PROBE_CODE = "zz-nexus-self-check";
// Not a dialable number, so it cannot match a real contact even by accident.
const PROBE_WA_ID = "999000000000001";
/** Constant, so cleanup can find the debris whatever failed above it. */
const PROBE_BOOKING_SUBJECT = "Self check probe — not a real appointment";

let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function removeProbe(organizationId: string) {
  const pool = getPool();
  // Assessments first: `lead_assessments.contact_id` is ON DELETE CASCADE, but
  // being explicit means the cleanup does not depend on a constraint staying
  // that way. The probe contact is NOT cascaded by deleting the employee —
  // `captured_by_employee_id` is ON DELETE SET NULL — so it has to go by hand
  // or every run would leave a contact behind.
  await pool.query(
    `delete from lead_assessments
      where contact_id in (select id from contacts where organization_id = $1 and wa_id = $2)`,
    [organizationId, PROBE_WA_ID]
  );
  await pool.query(`delete from contacts where organization_id = $1 and wa_id = $2`, [
    organizationId,
    PROBE_WA_ID,
  ]);
  await pool.query(`delete from employees where organization_id = $1 and employee_code = $2`, [
    organizationId,
    PROBE_CODE,
  ]);
}

/**
 * Booking, end to end, against the live database — including the refusal.
 *
 * THE ONE PROPERTY THAT CANNOT BE TESTED ANYWHERE ELSE. Every other check on
 * this feature reads source text or runs against a mock, and neither can know
 * whether `bookings_no_double_booking` exists, is valid, or still covers the
 * rows it was written for. A gist exclusion constraint is not ordinary DDL: it
 * needs `btree_gist` installed, it silently covers nothing if the WHERE clause
 * drifts, and application code catching `23P01` is catching an error only
 * Postgres can raise. If that constraint were dropped tomorrow, every test in
 * the suite would still pass and two customers would be given the same slot.
 *
 * EACH STEP IS ITS OWN COMMITTED TRANSACTION, for the reason the sign-in check
 * above had to learn: two inserts inside one transaction prove the constraint
 * fires, but they do not reproduce the situation it exists for. Two customers
 * messaging at the same moment are two connections. Committing between them is
 * what makes the second insert a genuine race against a row that is really
 * there.
 *
 * The probe employee is given a 24/7 schedule deliberately. A realistic one
 * would make this check pass or fail according to what time somebody happened
 * to run it, and a diagnostic that is only true in the mornings teaches people
 * to ignore it. The narrow-schedule behaviour — that an unscheduled employee is
 * never offered — is pure, and asserted in the unit suite.
 */
async function checkBookingRoundTrip(organizationId: string) {
  console.log("\nBookings (committed, against the live constraint)");

  const ALWAYS: Record<string, Array<{ start: string; end: string }>> = {
    mon: [{ start: "00:00", end: "23:59" }],
    tue: [{ start: "00:00", end: "23:59" }],
    wed: [{ start: "00:00", end: "23:59" }],
    thu: [{ start: "00:00", end: "23:59" }],
    fri: [{ start: "00:00", end: "23:59" }],
    sat: [{ start: "00:00", end: "23:59" }],
    sun: [{ start: "00:00", end: "23:59" }],
  };

  await withTenant(organizationId, () => removeProbe(organizationId));

  const employee = await withTenant(organizationId, async () => {
    const created = await createEmployee({
      organizationId,
      employeeCode: PROBE_CODE,
      fullName: "Self Check Bookable",
      jobTitle: "Diagnostic",
      timezone: "Asia/Dubai",
    });
    // No writer exists for working_hours in packages/db — schedules are set by
    // hand today — so the probe's is set here directly rather than pretending
    // an API for it exists.
    await getPool().query(`update employees set working_hours = $2::jsonb where id = $1`, [
      created.id,
      JSON.stringify(ALWAYS),
    ]);
    return created;
  });

  const contactId = await withTenant(organizationId, async () => {
    const { rows } = await getPool().query<{ id: string }>(
      `insert into contacts (organization_id, wa_id, display_name)
       values ($1, $2, 'Self check probe')
       on conflict (organization_id, wa_id) do update set display_name = excluded.display_name
       returning id`,
      [organizationId, PROBE_WA_ID]
    );
    return rows[0].id;
  });

  // Far enough ahead that it cannot collide with anything real, and on a grid
  // boundary so it matches what findAvailableSlots would have offered.
  const startsAt = new Date(Date.now() + 72 * 3_600_000);
  startsAt.setUTCMinutes(0, 0, 0);
  const endsAt = new Date(startsAt.getTime() + 60 * 60_000);

  try {
    const slots = await withTenant(organizationId, () =>
      findAvailableSlots({ organizationId, durationMinutes: 60, limit: 3 })
    );
    check(
      "availability offers real slots",
      slots.length > 0,
      slots.length > 0 ? `${slots.length} offered, first ${slots[0].startsAt}` : "none offered"
    );
    check(
      "an offered slot names who would take it",
      slots.every((slot) => Boolean(slot.employeeId && slot.employeeName)),
      "a slot with nobody on it is a promise the diary cannot keep"
    );

    const first = await withTenant(organizationId, () =>
      createBooking({
        organizationId,
        contactId,
        employeeId: employee.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        subject: PROBE_BOOKING_SUBJECT,
      })
    );
    check("a booking is taken", first.status === "confirmed", `${first.startsAt} with ${first.employeeName}`);

    // THE REFUSAL. Overlapping by half an hour, on the same employee, from a
    // separate committed transaction — the second customer.
    const overlapStart = new Date(startsAt.getTime() + 30 * 60_000);
    let refused = false;
    let refusedAs = "";
    try {
      await withTenant(organizationId, () =>
        createBooking({
          organizationId,
          contactId,
          employeeId: employee.id,
          startsAt: overlapStart.toISOString(),
          endsAt: new Date(overlapStart.getTime() + 60 * 60_000).toISOString(),
          subject: PROBE_BOOKING_SUBJECT,
        })
      );
      refusedAs = "the overlapping booking was ACCEPTED";
    } catch (err) {
      // Asserting the TYPE, not merely that something threw. A raw
      // exclusion_violation reaching a caller means the mapping in
      // createBooking has drifted, and the agent would tell a customer the
      // system was broken instead of offering them another time.
      refused = err instanceof SlotTakenError;
      refusedAs = refused
        ? "SlotTakenError"
        : `${err instanceof Error ? err.name : "unknown"} — not mapped to SlotTakenError`;
    }
    check("an overlapping booking is refused by the database", refused, refusedAs);

    // And the other half of the guarantee: cancelling must genuinely free the
    // slot. A constraint that never releases is a diary that fills up forever.
    await withTenant(organizationId, () => setBookingStatus(first.id, "cancelled"));
    let rebooked = false;
    try {
      const second = await withTenant(organizationId, () =>
        createBooking({
          organizationId,
          contactId,
          employeeId: employee.id,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          subject: PROBE_BOOKING_SUBJECT,
        })
      );
      rebooked = second.status === "confirmed";
    } catch {
      rebooked = false;
    }
    check("cancelling frees the slot for somebody else", rebooked);

    const upcoming = await withTenant(organizationId, () =>
      listUpcomingBookingsForContact(organizationId, contactId)
    );
    check(
      "the reply path can read the customer's appointments",
      upcoming.some((booking) => booking.subject === PROBE_BOOKING_SUBJECT),
      `${upcoming.length} upcoming`
    );

    // ------------------------------------------------------------------
    // THE TOOL HANDLERS, which nothing has ever run.
    // ------------------------------------------------------------------
    //
    // Everything above calls createBooking directly, with an organizationId and
    // no conversation, inside the business's OWN context. A customer produces
    // none of that. What a customer produces is the model calling
    // `check_availability` and then `book_appointment`, from inside the NUMBER
    // OWNER's transaction, against a conversation routed to the serving
    // business — and those handlers parse the model's arguments, open
    // withServingTenant, resolve the slot and decide what to report back.
    //
    // Between them, `bookings-are-real` reads the tool's SOURCE and the block
    // above exercises the layer BENEATH it. Nothing ran the layer in the
    // middle, on a platform with zero bookings, for the feature this product
    // leads with.
    //
    // THE ROUTED CONVERSATION IS THE POINT. A probe that leaves
    // routed_organization_id null makes a shape the switchboard never produces:
    // the conversations policy allows the serving business to see a conversation
    // ROUTED to it, so an unrouted one is correctly invisible and the booking is
    // correctly refused. I read that refusal as a defect on 2026-08-22 and
    // shipped a fix for it before rereading the policy. This section exists
    // partly so nobody repeats that from scratch.
    // This function is handed an id, not the row. The owner is resolved from
    // the business's phone number, so both are looked up together and once.
    const organization = await withAllTenants("self-check: the business being probed", async () =>
      (await listOrganizations()).find((candidate) => candidate.id === organizationId) ?? null
    );
    const owner = organization
      ? await withAllTenants("self-check: number owner", () =>
          findNumberOwner(organization.whatsappPhoneNumberId)
        )
      : null;
    if (owner && organization) {
      const toolStart = new Date(Date.now() + 96 * 3_600_000);
      toolStart.setUTCMinutes(0, 0, 0);

      await withTenant(owner.id, async () => {
        const { rows: conv } = await getPool().query<{ id: string }>(
          `insert into conversations (organization_id, contact_id, routed_organization_id)
           values ($1, $2, $3) returning id`,
          [owner.id, contactId, organizationId]
        );

        const ctx = {
          organizationId,
          businessSlug: organization.slug,
          contactWaId: PROBE_WA_ID,
          employeeId: null,
          contactId,
          conversationId: conv[0].id,
        };

        const offered = (await checkAvailabilityTool.handler({}, ctx as never)) as {
          slots?: Array<{ startsAt: string }>;
        };
        check(
          "check_availability offers slots through the tool, in the owner's transaction",
          Array.isArray(offered.slots) && offered.slots.length > 0,
          `${offered.slots?.length ?? 0} offered`
        );

        if (offered.slots?.length) {
          const booked = (await bookAppointmentTool.handler(
            { startsAt: offered.slots[0].startsAt, subject: PROBE_BOOKING_SUBJECT },
            ctx as never
          )) as { booked?: boolean; reason?: string };
          check(
            "book_appointment takes a slot check_availability just offered",
            booked.booked === true,
            booked.booked ? "booked" : `refused: ${booked.reason}`
          );

          // The same slot twice. This is the guarantee the exclusion constraint
          // exists for, reached through the tool rather than around it.
          const again = (await bookAppointmentTool.handler(
            { startsAt: offered.slots[0].startsAt, subject: PROBE_BOOKING_SUBJECT },
            ctx as never
          )) as { booked?: boolean; reason?: string };
          check(
            "and refuses to take it a second time",
            again.booked === false,
            again.booked ? "DOUBLE BOOKED" : `refused: ${again.reason}`
          );
        }

        // The conversation is the probe's own and is removed with it. The
        // bookings it made carry PROBE_BOOKING_SUBJECT and are swept by the
        // finally below, which deletes by subject rather than by an id a
        // failure may have prevented being assigned.
        await getPool()
          .query(`delete from conversations where id = $1`, [conv[0].id])
          .catch(() => undefined);
      });
    } else {
      check("check_availability offers slots through the tool, in the owner's transaction", false,
        "no number owner resolved — this business's phone number maps to nobody");
    }
  } finally {
    // By SUBJECT and by wa_id, never by an id a failure may have prevented
    // being assigned — the lesson schema-check's cleanup is written around. A
    // probe appointment left in production appears in the diary as a real
    // customer somebody is expected to meet, and holds a slot the constraint
    // will refuse to everybody else.
    await withTenant(organizationId, async () => {
      await getPool()
        .query(`delete from bookings where organization_id = $1 and subject = $2`, [
          organizationId,
          PROBE_BOOKING_SUBJECT,
        ])
        .catch(() => undefined);
      await getPool()
        .query(`delete from contacts where organization_id = $1 and wa_id = $2`, [
          organizationId,
          PROBE_WA_ID,
        ])
        .catch(() => undefined);
      await removeProbe(organizationId);
    });

    const leftover = await withTenant(organizationId, async () => {
      const { rows } = await getPool().query<{ n: string }>(
        `select count(*)::text as n from bookings where organization_id = $1 and subject = $2`,
        [organizationId, PROBE_BOOKING_SUBJECT]
      );
      return Number(rows[0]?.n ?? 0);
    });
    check("probe appointments removed", leftover === 0, leftover === 0 ? "" : `${leftover} left behind`);
  }
}

/**
 * Employee sign-in, exercised the way the route actually runs.
 *
 * Separate from the main employee block for two reasons, and both are the
 * difference between a check and a decoration:
 *
 *  1. NO TENANT CONTEXT. /auth/employee is unauthenticated by necessity —
 *     resolving the identifier is what discovers the tenant. Asserting this
 *     from inside withTenant(...) is what let sign-in stay broken in production
 *     for every employee while this file reported "ok" on every run.
 *
 *  2. COMMITTED. withTenant opens a transaction, so a probe created inside one
 *     is invisible to any other connection — which is exactly what an
 *     unauthenticated caller is. The probe therefore has to be committed before
 *     it can be looked up the way a real employee is. Discovered by this check
 *     failing honestly the first time it ran for real.
 *
 * Each step gets its own committed transaction, so the lookup sees the same
 * state a browser would.
 */
async function checkUnauthenticatedSignIn(organizationId: string) {
  console.log("\nEmployee sign-in (as an unauthenticated caller)");

  await withTenant(organizationId, () => removeProbe(organizationId));

  const code = generateAccessCode();
  const employee = await withTenant(organizationId, async () => {
    const created = await createEmployee({
      organizationId,
      employeeCode: PROBE_CODE,
      fullName: "Self Check Sign-in",
      email: "self-check@nexus.invalid",
      jobTitle: "Diagnostic",
    });
    await setEmployeeAccessCodeHash(created.id, hashAccessCode(code));
    return created;
  });

  try {
    const byEmail = await withoutTenant(() => findEmployeeForLogin("self-check@nexus.invalid"));
    check("lookup by email with no tenant context", byEmail?.id === employee.id);

    const byCode = await withoutTenant(() => findEmployeeForLogin(PROBE_CODE.toUpperCase()));
    check("lookup is case-insensitive", byCode?.id === employee.id);

    check("the issued code verifies", verifyAccessCode(code, byEmail?.accessCodeHash ?? null));
    check("a wrong code does not", !verifyAccessCode("AAAAA-BBBBB", byEmail?.accessCodeHash ?? null));
    check("scope names the right business", byEmail?.organizationSlug === "zipicka", byEmail?.organizationSlug);

    // Revocation has to hold on the same unauthenticated path, or a
    // deactivated employee keeps a working login.
    await withTenant(organizationId, () => deactivateEmployee(employee.id).then(() => undefined));
    const revoked = await withoutTenant(() => findEmployeeForLogin("self-check@nexus.invalid"));
    check("deactivating revokes the login", revoked === null);
  } finally {
    await withTenant(organizationId, () => removeProbe(organizationId));
    console.log("  ok    sign-in probe removed");
  }
}

/**
 * Can each business's own wording be read from the transaction that sends it?
 *
 * WHAT IS AT STAKE. When the agent escalates, the customer receives either the
 * business's authored phrase or the platform's generic fallback, and the ONLY
 * thing standing between them is that `getActivePhrase` widens at the read.
 * Five firms share one number, so this is asked about the SERVING business from
 * inside the NUMBER OWNER's transaction: unscoped, RLS returns no rows, and the
 * caller cannot tell "this firm has written nothing" from "this firm's words
 * are invisible from here". The fallback goes out, reads perfectly well, and is
 * not what the firm wrote.
 *
 * NOT HYPOTHETICAL. `getActivePhrase` is one of the nine original instances of
 * that defect on this platform. It was fixed at the read; nothing has ever
 * checked that it stayed fixed, and the fix is one deleted wrapper away from
 * being undone with no test failing.
 *
 * IT ALSO CHECKS THE WORDING IS SENDABLE. A phrase carrying an unfilled
 * {{placeholder}} reaches the customer exactly as written. The activation route
 * refuses to switch one on -- but a phrase already active when a placeholder is
 * introduced by an edit elsewhere would not pass back through that guard.
 */
async function checkPhrasesReachTheCustomer(ownerId: string) {
  console.log("\nAuthored wording (read as the reply path reads it)");

  const businesses = await withAllTenants("self-check: every business's wording", () =>
    listOrganizations()
  );

  // One transaction, the owner's, exactly as the reply pipeline holds it.
  await withTenant(ownerId, async () => {
    let anyActive = false;

    for (const business of businesses) {
      for (const moment of PHRASE_MOMENTS) {
        const phrase = await getActivePhrase(business.id, moment).catch(() => null);
        if (!phrase) continue;
        anyActive = true;

        check(
          `${business.slug}/${moment} is readable from the owner's transaction`,
          phrase.body.trim().length > 0,
          `${phrase.body.slice(0, 44)}…`
        );
        check(
          `${business.slug}/${moment} has nothing left to fill in`,
          unfilledPlaceholders(phrase.body).length === 0,
          unfilledPlaceholders(phrase.body).join(", ") || "no placeholders"
        );
      }
    }

    // A silent pass is the failure this whole function exists to prevent: if
    // the widening broke, every read above returns null and the loop asserts
    // nothing at all while reporting no problem.
    check(
      "at least one business's wording was found",
      anyActive,
      anyActive ? "found" : "NONE — either nothing is active anywhere, or the read stopped widening"
    );
  });
}

async function main() {
  console.log("Nexus self-check — live database\n");

  // ---------- tenants ----------
  console.log("Tenants");
  // Registry reads. `organizations` is the tenant registry, not tenant data —
  // scoping the lookup that decides which tenant we are would be circular.
  const organizations = await withAllTenants("self-check: tenant registry", () => listOrganizations());
  check("all five businesses active", organizations.length === 5, `${organizations.length} found`);

  const zipicka = await withAllTenants("self-check: tenant registry", () =>
    findOrganizationBySlug("zipicka")
  );
  if (!zipicka) throw new Error("zipicka not found — cannot continue");

  // ---------- switchboard ----------
  console.log("\nSwitchboard");
  const businesses = await withAllTenants("self-check: shared-number lookup", () =>
    findSharedNumberBusinesses(zipicka.whatsappPhoneNumberId)
  );
  check("shared number reaches five businesses", businesses.length === 5, `${businesses.length} reachable`);

  // The routing decisions that matter, made from the live keyword rows rather
  // than a fixture — this is the pairing migration 008 exists to get right.
  const routes: Array<[string, string]> = [
    ["I need true copy attestation for my certificate", "juris-prime"],
    // Deliberately NOT "I need a lawyer for a court case" any more. ABR joined
    // as a second law firm (migration 014), so that phrasing is ambiguous now —
    // and the ambiguity is the correct answer, asserted separately below.
    ["company formation in a freezone and a power of attorney", "juris-prime-legal"],
    ["criminal case, we need to appeal to cassation", "abr"],
    ["do you have a villa for rent", "sfs-international"],
    ["do you have this beauty product in stock", "zipicka"],
    ["أحتاج تصديق شهادة", "juris-prime"],
  ];
  for (const [text, expected] of routes) {
    const outcome = classifyBusiness(text, businesses);
    check(
      `routes: "${text.slice(0, 34)}"`,
      outcome.kind === "routed" && outcome.business.slug === expected,
      outcome.kind === "routed" ? outcome.business.slug : outcome.kind
    );
  }
  check("a bare greeting asks rather than guessing", classifyBusiness("hi", businesses).kind === "unknown");

  // "I need a lawyer" is NO LONGER the ambiguous case, and that is deliberate.
  //
  // Migration 024 assigned lawyer/lawyers/advocate/محامي to ABR alone, reasoning
  // that someone asking for a lawyer wants representation and the firm is
  // literally named Advocates, while Juris Prime Legal's clients ask about
  // company setup. It kept "legal" and "قانوني" shared on purpose, because both
  // are legal practices and the word is honest evidence for either.
  //
  // This check asserted the pre-024 behaviour and had been failing ever since —
  // invisibly, because self-check itself was dead under RLS. Reviving the gate
  // surfaced it within a minute. Both halves of 024's decision are now pinned,
  // so a future collision pass cannot quietly undo either one.
  const named = classifyBusiness("I need a lawyer", businesses);
  check(
    "asking for a lawyer reaches the litigators",
    named.kind === "routed" && named.business.slug === "abr",
    named.kind === "routed" ? named.business.slug : named.kind
  );

  // The genuinely ambiguous phrasing: only the shared word matches, and both
  // firms are equally good answers. Guessing here would send a criminal matter
  // to a company-formation desk — and routing also picks which governance
  // policy approves the reply.
  const vagueLegal = classifyBusiness("I need legal help", businesses);
  const firms =
    vagueLegal.kind === "ambiguous" ? vagueLegal.candidates.map((b) => b.slug).sort() : [];
  check(
    "a vague legal enquiry asks which firm",
    vagueLegal.kind === "ambiguous" && firms.join(",") === "abr,juris-prime-legal",
    vagueLegal.kind === "ambiguous" ? firms.join(" + ") : vagueLegal.kind
  );

  // ---------- customer links ----------
  //
  // The five links are what this platform is asking its owner to publish on
  // websites, Instagram bios and printed QR codes — places a correction is
  // expensive and slow. Nothing verified them until now.
  //
  // The failure they invite is the shape this document keeps describing: a
  // link that is well-formed, opens WhatsApp, prefills a message and looks
  // perfect, but whose tag does not parse back to the business it was built
  // for. Every customer who taps it lands in the triage menu instead, which
  // reads as "the routing is a bit clumsy" rather than as a broken link — and
  // the only people who could notice are the ones who never complain.
  console.log("\nCustomer links");
  const displayNumbers = await withAllTenants("self-check: display numbers", () =>
    getDisplayNumbers()
  );

  for (const business of businesses) {
    const number = displayNumbers.get(business.id);
    if (!number) {
      // Not a failure of the link builder. A business with no dialable number
      // legitimately has no link, and the page says so — but it is worth
      // naming here, because it means that business cannot be advertised.
      console.log(`  —     ${business.slug.padEnd(20)} no dialable number, so no link to publish`);
      continue;
    }

    const url = buildDeepLink(business, number);

    // 1. It must be a wa.me link to the DIALABLE number. Built from
    //    whatsapp_phone_number_id it would look right, publish fine, and fail
    //    for every customer who tapped it.
    const digits = number.replace(/\D/g, "");
    check(
      `${business.slug}: link points at the dialable number`,
      url.startsWith(`https://wa.me/${digits}?text=`),
      url.slice(0, 34)
    );

    // 2. THE ROUND TRIP. Decode the prefilled text the customer will actually
    //    send, and route it exactly as the webhook would. This is the assertion
    //    that matters: the builder and the parser agreeing is the whole
    //    contract, and they live in different functions that could drift.
    const prefilled = decodeURIComponent(url.split("?text=")[1] ?? "");
    const outcome = classifyBusiness(prefilled, businesses);
    check(
      `${business.slug}: tapping it reaches ${business.slug}`,
      outcome.kind === "routed" && outcome.business.slug === business.slug,
      outcome.kind === "routed" ? outcome.business.slug : outcome.kind
    );
  }

  // ---------- knowledge ----------
  console.log("\nKnowledge retrieval");
  const queries: Array<[string, string]> = [
    ["juris-prime", "how do I get MOFA attestation for my degree?"],
    ["juris-prime-legal", "can you help with company formation?"],
    ["sfs-international", "how do I contact the agency?"],
    ["zipicka", "how long do I have to return an item?"],
    ["abr", "do you handle criminal defence and appeals?"],
  ];
  for (const [slug, question] of queries) {
    const organization = await withAllTenants("self-check: tenant registry", () =>
      findOrganizationBySlug(slug)
    );
    if (!organization) {
      check(`${slug}: organization exists`, false);
      continue;
    }
    // Scoped to the business being asked about. Retrieval reads
    // knowledge_chunks, which is tenant-scoped — unscoped it returns nothing
    // under RLS, and "NOTHING MATCHED" would be reported as a knowledge gap
    // rather than as a missing context.
    const hits = await withTenant(organization.id, () =>
      searchKnowledge({ organizationId: organization.id, query: question, limit: 3 })
    );
    // Asserts that expected data EXISTS, rather than that nothing threw —
    // the operating rule this codebase arrived at the hard way.
    check(
      `${slug}: "${question.slice(0, 32)}"`,
      hits.length > 0,
      hits.length > 0 ? `top score ${hits[0].score.toFixed(3)}` : "NOTHING MATCHED"
    );
  }

  // Cross-tenant isolation: the retail question must find nothing in the law
  // firm's knowledge base. A leak here is silent and reads as a good answer.
  const legal = await withAllTenants("self-check: tenant registry", () =>
    findOrganizationBySlug("juris-prime-legal")
  );
  if (legal) {
    const leak = await withTenant(legal.id, () =>
      searchKnowledge({
      organizationId: legal.id,
      query: "free delivery on orders over Dhs 50 pet food",
      limit: 3,
      })
    );
    const leaked = leak.some((hit) => /delivery|pet food|dhs/i.test(hit.content));
    check("retail content does not surface in the law firm's base", !leaked);
  }

  // ---------- employees ----------
  console.log("\nEmployee layer");

  // EVERYTHING BELOW RUNS IN ZIPICKA'S TENANT CONTEXT.
  //
  // This script had no context anywhere, and had therefore been DEAD since RLS
  // was enabled: its reads returned zero rows, and `createEmployee` aborted the
  // whole run with "new row violates row-level security policy". One of the
  // four verification gates, verifying nothing, for as long as the policies
  // have been on.
  //
  // It was missed because `rls-preflight` enumerates the WRITERS it knows about
  // — the crawler, the scheduled template sync, the quality rollup — and
  // self-check is filed mentally as a checker rather than a writer. It writes
  // an employee, a contact and a lead on every single run.
  await withTenant(zipicka.id, async () => {
    await removeProbe(zipicka.id);

    try {
    const employee = await createEmployee({
      organizationId: zipicka.id,
      employeeCode: PROBE_CODE,
      fullName: "Self Check",
      email: "self-check@nexus.invalid",
      jobTitle: "Diagnostic",
      whatsappNumber: "+971 50 000 0000",
    });
    check("create employee", Boolean(employee.id), employee.employeeCode);

    const upserted = await createEmployee({
      organizationId: zipicka.id,
      employeeCode: PROBE_CODE,
      fullName: "Self Check Renamed",
    });
    check("re-submitting updates instead of failing", upserted.id === employee.id);

    const fetched = await findEmployeeById(employee.id);
    check("read back by id", fetched?.employeeCode === PROBE_CODE);

    const roster = await listEmployees(zipicka.id);
    check("appears on the roster", roster.some((e) => e.id === employee.id), `${roster.length} on roster`);

    const presence = resolvePresence(employee);
    check("presence resolves", typeof presence.status === "string", presence.status);

    // Access code round trip — the security-critical path.
    const code = generateAccessCode();
    check("issue access code", await setEmployeeAccessCodeHash(employee.id, hashAccessCode(code)));

    // The sign-in lookups are NOT checked here — see checkUnauthenticatedSignIn
    // below. They need a caller with no tenant context, and this block is one
    // open transaction, so an uncommitted probe employee is invisible from the
    // outside. Asserting them here is what made them meaningless before.
    check("wrong code does not verify", !verifyAccessCode("AAAAA-BBBBB", hashAccessCode(code)));

    await recordEmployeeLogin(employee.id, zipicka.id);
    check("record login", true);

    // The assigned-conversations query — the most intricate SQL in the layer,
    // joining contacts, messages and the ROUTED organization.
    const assigned = await listConversationsForEmployee(employee.id);
    check("assigned-conversations query runs", Array.isArray(assigned), `${assigned.length} assigned`);

    const contact = buildDirectContact({
      employee,
      businessName: zipicka.name,
      customerWaId: "971500000002",
      customerName: "Test",
    });
    check("direct-contact link builds", contact?.url.startsWith("https://wa.me/971500000002") === true);
    check("employee's own number normalises", contact?.sendingAs === "971500000000", contact?.sendingAs ?? "null");

    // ---------- leads from an employee's own phone ----------
    console.log("\nEmployee-sourced leads");

    const captured = await captureEmployeeLead({
      organizationId: zipicka.id,
      employeeId: employee.id,
      contactWaId: PROBE_WA_ID,
      contactName: "Self Check Customer",
      note: "asking the price for a bulk order, wants delivery",
    });
    check("capture a lead", Boolean(captured.contactId), `score ${captured.score} / ${captured.priority}`);
    check("a first capture creates the contact", captured.isNewContact);
    check("scores above zero on real buying words", captured.score > 0, String(captured.score));
    check("carries its evidence", captured.signals.length > 0, `${captured.signals.length} signals`);

    // Re-capturing the same person must not create a second contact, and must
    // not hand the credit to whoever logged the most recent note.
    const again = await captureEmployeeLead({
      organizationId: zipicka.id,
      employeeId: employee.id,
      contactWaId: PROBE_WA_ID,
      contactName: "",
      note: "following up, still wants the bulk price",
    });
    check("re-capture reuses the same contact", again.contactId === captured.contactId);
    check("re-capture is not a new contact", !again.isNewContact);

    const leadRows = await listEmployeeLeads(zipicka.id, employee.id);
    check("leads list query runs", Array.isArray(leadRows), `${leadRows.length} rows`);
    check("both captures are listed", leadRows.length >= 2);
    check(
      "the note is stored, not just the score",
      leadRows.some((row) => (row.note ?? "").includes("bulk")),
      leadRows[0]?.note?.slice(0, 40) ?? "(none)"
    );
    check("attributed to the employee", leadRows[0]?.employeeName === "Self Check Renamed", leadRows[0]?.employeeName ?? "null");

    // The standing cache on `contacts` must reflect the best score reached,
    // which is what the inbox sorts on.
    const { rows: standing } = await getPool().query<{ lead_score: number | null; lead_priority: string | null }>(
      `select lead_score, lead_priority from contacts where organization_id = $1 and wa_id = $2`,
      [zipicka.id, PROBE_WA_ID]
    );
    check(
      "contact standing updated",
      (standing[0]?.lead_score ?? 0) >= captured.score,
      `score ${standing[0]?.lead_score} / ${standing[0]?.lead_priority}`
    );

    // Deactivating must revoke the login in the same action.
    console.log("\nEmployee layer (continued)");
    check("deactivate", await deactivateEmployee(employee.id));
    // Revocation is asserted in checkUnauthenticatedSignIn instead, where the
    // lookup runs without a tenant context — the same conditions the sign-in
    // route runs under. Checking it here only proved it inside a scope the
    // route never has.
    } finally {
      await removeProbe(zipicka.id);
      console.log("  ok    probe employee removed");
    }
  });

  await checkUnauthenticatedSignIn(zipicka.id);
  await checkBookingRoundTrip(zipicka.id);
  await checkPhrasesReachTheCustomer(zipicka.id);

  console.log(
    failures === 0
      ? "\nAll checks passed."
      : `\n${failures} CHECK(S) FAILED — see above.`
  );
  await getPool().end();
  return failures === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch(async (err) => {
      console.error("\nSelf-check aborted:", err);
      process.exit(1);
    });
}
