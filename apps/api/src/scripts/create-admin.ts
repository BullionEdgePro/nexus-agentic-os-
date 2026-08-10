/**
 * Create an admin account, or reset an existing one's password.
 *
 *   docker compose -f docker-compose.prod.yml exec -T worker \
 *     npx tsx apps/api/src/scripts/create-admin.ts you@example.com "Your Name"
 *
 * The password is generated HERE, on the server, printed once, and stored only
 * as a scrypt hash. It is never accepted as an argument, for the same reason
 * employee access codes are not: a password passed on a command line lands in
 * shell history, and a password chosen in a conversation lands in a transcript.
 *
 * Re-running for an existing email resets that account's password. That is the
 * whole recovery story — there is no reset flow and no recovery channel to
 * protect, which is the right shape for a handful of accounts on an internal
 * platform.
 */
import { pathToFileURL } from "node:url";
import { getPool, upsertAdmin, listAdmins } from "@nexus/db";
import { hashSecret, generatePassword } from "@nexus/employees";

async function main(): Promise<number> {
  const email = process.argv[2];
  const fullName = process.argv[3];

  if (!email || !fullName) {
    console.error('usage: tsx apps/api/src/scripts/create-admin.ts <email> "<full name>"');
    console.error("");
    const existing = await listAdmins();
    if (existing.length) {
      console.error("Existing admin accounts:");
      for (const admin of existing) {
        console.error(
          `  ${admin.isActive ? "active  " : "disabled"}  ${admin.email}  (${admin.fullName})` +
            (admin.lastLoginAt ? `  last login ${admin.lastLoginAt}` : "  never signed in")
        );
      }
    } else {
      console.error("No admin accounts exist yet.");
    }
    return 2;
  }

  if (!/.+@.+\..+/.test(email)) {
    console.error(`"${email}" is not an email address.`);
    return 2;
  }

  const existing = await listAdmins();
  const isReset = existing.some((admin) => admin.email.toLowerCase() === email.toLowerCase());

  const password = generatePassword();
  const admin = await upsertAdmin({ email, fullName, passwordHash: hashSecret(password) });

  console.log("");
  console.log(isReset ? "Password reset for existing admin." : "Admin account created.");
  console.log("");
  console.log(`  Sign in at   https://nexusagenticos.com/admin`);
  console.log(`  Email        ${admin.email}`);
  console.log(`  Password     ${password}`);
  console.log("");
  console.log("Shown once — only a scrypt hash is stored, so this cannot be displayed again.");
  console.log("Re-run this command to set a new password.");
  console.log("");

  // Assert the account can actually be found the way sign-in will find it,
  // rather than trusting that the INSERT means a working login. A row that
  // exists but cannot be looked up is the shape of failure this codebase keeps
  // producing.
  const { findAdminByEmail } = await import("@nexus/db");
  const found = await findAdminByEmail(email.toUpperCase());
  if (!found || found.id !== admin.id) {
    console.error("WARNING: the account was written but could not be looked up by email.");
    return 1;
  }

  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then(async (code) => {
      await getPool().end();
      process.exit(code);
    })
    .catch((err) => {
      console.error("Failed:", err);
      process.exit(1);
    });
}
