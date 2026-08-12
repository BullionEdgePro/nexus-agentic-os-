import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { ConsoleShell } from "../console-shell";

/**
 * Every /deck/* screen sits inside the shared console frame.
 *
 * A nested layout rather than a wrapper each page imports, because the point is
 * that a page cannot forget. Nine screens shipped without navigation precisely
 * because adding it was each page's own responsibility.
 *
 * The role is resolved HERE, on the server, and handed down. The rail hides
 * what an employee cannot open, and deciding that on the client would mean
 * shipping the operator's menu to everyone and removing it after hydration —
 * a visible flicker of screens they will be refused, and a list of internal
 * URLs handed to someone who was not meant to have it.
 */
export const dynamic = "force-dynamic";

export default async function DeckLayout({ children }: { children: React.ReactNode }) {
  const session = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);

  // The middleware already redirects anyone without a session, so reaching here
  // unauthenticated is a wiring mistake rather than a request. Falling back to
  // "employee" is the safe reading: the narrower menu.
  return <ConsoleShell role={session?.role ?? "employee"}>{children}</ConsoleShell>;
}
