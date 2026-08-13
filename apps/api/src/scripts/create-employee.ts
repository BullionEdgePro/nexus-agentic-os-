/**
 * Put a person on a business's rota.
 *
 *   docker compose -f docker-compose.prod.yml exec -T worker \
 *     npx tsx apps/api/src/scripts/create-employee.ts \
 *       zipicka "Ralph Ivan Simeon" marketing@zipicka.com 971525631476 "Sales executive"
 *
 * With no arguments it lists who is already on each rota, so the first thing
 * you do is never a blind write.
 *
 * WHY A SCRIPT AND NOT THE SCREEN. The roster UI exists and works, but it needs
 * an operator signed in, and this is the one action whose absence has the
 * largest effect on the platform: with an empty rota, escalation has nowhere to
 * go (ARCHITECTURE §9.5). Making the fix depend on somebody's browser session is
 * how it stays undone. Same reasoning as create-admin.ts, next to which this
 * sits.
 *
 * WHAT ADDING SOMEONE CHANGES — and it is not only additive:
 *
 * With no staff, `hasActiveEmployees()` is false, so the agent answers
 * everything itself and never promises a specialist. The moment this script
 * succeeds, that flips for the whole business: escalation begins promising THIS
 * PERSON and setting `is_human_handoff`, which pauses the AI on that
 * conversation until they reply. That is the intended design and it is also a
 * commitment — a rota with a name on it that nobody reads is worse than an
 * empty one, because the empty one degrades honestly.
 *
 * The script says so out loud when it finishes, because the person running it
 * is usually not the person who will be watching the inbox.
 */
import { pathToFileURL } from "node:url";
import {
  findOrganizationBySlug,
  listOrganizations,
  listEmployees,
  createEmployee,
  setEmployeeAccessCodeHash,
  withAllTenants,
  withTenant,
} from "@nexus/db";
import { generateAccessCode, hashAccessCode } from "@nexus/employees";

/**
 * A short, human-typeable identifier unique within the business.
 *
 * Derived from the name rather than random, because it appears in the roster
 * and in handover notes, and "rsimeon" tells a colleague who that is where
 * "emp-7f2a" does not. Collisions are resolved by the caller passing an
 * explicit code — the unique index on (organization_id, employee_code) refuses
 * a duplicate rather than silently making one up.
 */
function deriveCode(fullName: string): string {
  const parts = fullName.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "staff";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const code = (last ? `${first[0]}${last}` : first).replace(/[^a-z0-9]/g, "");
  return code.slice(0, 20) || "staff";
}

/**
 * Digits only, as a customer would dial it.
 *
 * The direct-contact link is built from this value, and a number carrying
 * spaces, brackets or a leading + produces a wa.me URL that opens WhatsApp on
 * nothing. Rejected rather than silently cleaned past a plausible length, so a
 * typo surfaces here instead of in a customer's chat.
 */
function normaliseNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new Error(`"${raw}" is not a phone number a customer could dial.`);
  }
  return digits;
}

async function listRotas(): Promise<void> {
  const organizations = await withAllTenants("create-employee: roster overview", () =>
    listOrganizations()
  );

  console.log("Who is on each rota\n");
  // No is_active filter here: listOrganizations already applies one, so the
  // retired tenant never reaches this loop. A second check would read as
  // defensive and would in fact be dead code.
  for (const organization of organizations) {
    const staff = await withTenant(organization.id, () => listEmployees(organization.id));
    const active = staff.filter((person) => person.isActive);
    console.log(
      `  ${organization.slug.padEnd(20)} ${
        active.length === 0
          ? "NOBODY — escalation has nowhere to go"
          : active.map((p) => `${p.fullName} (${p.employeeCode})`).join(", ")
      }`
    );
  }
  console.log("\nTo add someone:");
  console.log(
    '  npx tsx apps/api/src/scripts/create-employee.ts <business> "<full name>" <email> <whatsapp> "<job title>"'
  );
}

async function main(): Promise<void> {
  const [slug, fullName, email, whatsapp, jobTitle] = process.argv.slice(2);

  if (!slug) {
    await listRotas();
    return;
  }

  if (!fullName || !email) {
    throw new Error('Need at least: <business> "<full name>" <email>');
  }

  const organization = await withAllTenants("create-employee: tenant lookup", () =>
    findOrganizationBySlug(slug)
  );
  if (!organization) throw new Error(`No business with slug "${slug}".`);

  const employeeCode = deriveCode(fullName);
  const whatsappNumber = whatsapp ? normaliseNumber(whatsapp) : null;

  const employee = await withTenant(organization.id, () =>
    createEmployee({
      organizationId: organization.id,
      employeeCode,
      fullName,
      email,
      jobTitle: jobTitle ?? null,
      whatsappNumber,
    })
  );

  // The code is generated here and shown ONCE. Only its hash is stored, so
  // there is no way to recover it later — a lost code is reissued, not looked
  // up, which is the same property the admin bootstrap has.
  const accessCode = generateAccessCode();
  const ok = await withTenant(organization.id, () =>
    setEmployeeAccessCodeHash(employee.id, hashAccessCode(accessCode))
  );
  if (!ok) throw new Error("Created the employee but could not set their access code.");

  console.log(`\n  ${employee.fullName} is on ${organization.slug}'s rota.\n`);
  console.log(`    sign in at   https://nexusagenticos.com`);
  console.log(`    email        ${email}`);
  console.log(`    access code  ${accessCode}`);
  console.log(`    employee id  ${employee.employeeCode}`);
  if (whatsappNumber) console.log(`    whatsapp     +${whatsappNumber}`);

  console.log(`
  Shown once — only a hash is stored. A lost code is reissued, not recovered.

  WHAT JUST CHANGED FOR ${organization.slug.toUpperCase()}: until now the agent
  answered everything itself and promised nobody, because there was nobody to
  promise. From the next escalation it will tell the customer a specialist is
  following up, and pause itself on that conversation until ${employee.fullName}
  replies. If that inbox is not going to be watched, deactivate this account —
  an empty rota degrades honestly, a rota nobody reads does not.
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
