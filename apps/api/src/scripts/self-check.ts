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
import {
  getPool,
  withTenant,
  withAllTenants,
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
} from "@nexus/db";
import {
  generateAccessCode,
  hashAccessCode,
  verifyAccessCode,
  buildDirectContact,
  resolvePresence,
} from "@nexus/employees";
import { classifyBusiness, buildDeepLink } from "@nexus/agents";
import { captureEmployeeLead, listEmployeeLeads } from "@nexus/leads";
import { searchKnowledge } from "@nexus/knowledge";

// Reserved so a self-check can never collide with a real person.
const PROBE_CODE = "zz-nexus-self-check";
// Not a dialable number, so it cannot match a real contact even by accident.
const PROBE_WA_ID = "999000000000001";

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

    const byEmail = await findEmployeeForLogin("self-check@nexus.invalid");
    check("sign-in lookup by email", byEmail?.id === employee.id);
    const byCode = await findEmployeeForLogin(PROBE_CODE.toUpperCase());
    check("sign-in lookup is case-insensitive", byCode?.id === employee.id);
    check("correct code verifies", verifyAccessCode(code, byEmail?.accessCodeHash ?? null));
    check("wrong code does not verify", !verifyAccessCode("AAAAA-BBBBB", byEmail?.accessCodeHash ?? null));
    check("scope names the right business", byEmail?.organizationSlug === "zipicka", byEmail?.organizationSlug);

    await recordEmployeeLogin(employee.id);
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
    check("deactivated employee cannot sign in", (await findEmployeeForLogin(PROBE_CODE)) === null);
    } finally {
      await removeProbe(zipicka.id);
      console.log("  ok    probe employee removed");
    }
  });

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
