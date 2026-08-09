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
} from "@nexus/db";
import {
  generateAccessCode,
  hashAccessCode,
  verifyAccessCode,
  buildDirectContact,
  resolvePresence,
} from "@nexus/employees";
import { classifyBusiness } from "@nexus/agents";
import { searchKnowledge } from "@nexus/knowledge";

// Reserved so a self-check can never collide with a real person.
const PROBE_CODE = "zz-nexus-self-check";

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
  await getPool().query(`delete from employees where organization_id = $1 and employee_code = $2`, [
    organizationId,
    PROBE_CODE,
  ]);
}

async function main() {
  console.log("Nexus self-check — live database\n");

  // ---------- tenants ----------
  console.log("Tenants");
  const organizations = await listOrganizations();
  check("all five businesses active", organizations.length === 5, `${organizations.length} found`);

  const zipicka = await findOrganizationBySlug("zipicka");
  if (!zipicka) throw new Error("zipicka not found — cannot continue");

  // ---------- switchboard ----------
  console.log("\nSwitchboard");
  const businesses = await findSharedNumberBusinesses(zipicka.whatsappPhoneNumberId);
  check("shared number reaches five businesses", businesses.length === 5, `${businesses.length} reachable`);

  // The routing decisions that matter, made from the live keyword rows rather
  // than a fixture — this is the pairing migration 008 exists to get right.
  const routes: Array<[string, string]> = [
    ["I need true copy attestation for my certificate", "juris-prime"],
    ["I need a lawyer for a court case", "juris-prime-legal"],
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

  // ---------- knowledge ----------
  console.log("\nKnowledge retrieval");
  const queries: Array<[string, string]> = [
    ["juris-prime", "how do I get MOFA attestation for my degree?"],
    ["juris-prime-legal", "can you help with company formation?"],
    ["sfs-international", "how do I contact the agency?"],
    ["zipicka", "how long do I have to return an item?"],
  ];
  for (const [slug, question] of queries) {
    const organization = await findOrganizationBySlug(slug);
    if (!organization) {
      check(`${slug}: organization exists`, false);
      continue;
    }
    const hits = await searchKnowledge({ organizationId: organization.id, query: question, limit: 3 });
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
  const legal = await findOrganizationBySlug("juris-prime-legal");
  if (legal) {
    const leak = await searchKnowledge({
      organizationId: legal.id,
      query: "free delivery on orders over Dhs 50 pet food",
      limit: 3,
    });
    const leaked = leak.some((hit) => /delivery|pet food|dhs/i.test(hit.content));
    check("retail content does not surface in the law firm's base", !leaked);
  }

  // ---------- employees ----------
  console.log("\nEmployee layer");
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

    // Deactivating must revoke the login in the same action.
    check("deactivate", await deactivateEmployee(employee.id));
    check("deactivated employee cannot sign in", (await findEmployeeForLogin(PROBE_CODE)) === null);
  } finally {
    await removeProbe(zipicka.id);
    console.log("  ok    probe employee removed");
  }

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
