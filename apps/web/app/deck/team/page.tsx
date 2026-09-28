import { cookies } from "next/headers";
import type { BusinessSlug } from "@nexus/shared";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import TeamWorkspace from "./team-workspace";
import { TeamDirectory } from "./team-directory";

export const dynamic = "force-dynamic";

/**
 * The team — two screens behind one door, decided on the server.
 *
 * The OWNER gets the workspace: pick a business, manage the roster, issue
 * sign-in codes, set rotas and the inbox rules.
 *
 * STAFF used to get that same workspace. The API refused what they could not
 * do, but the page still drew every business's tab, a Remove button beside each
 * colleague, the add-someone form and the owner's settings — controls that
 * either failed with an error or (until 2026-09-28, for add and remove) quietly
 * worked. A staff member now gets the directory: who is on the team and who is
 * on shift right now, read-only.
 */
export default async function TeamPage() {
  const session = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  if (session?.role === "employee" && session.organizationSlug) {
    return <TeamDirectory slug={session.organizationSlug as BusinessSlug} myId={session.employeeId ?? null} />;
  }
  return <TeamWorkspace />;
}
