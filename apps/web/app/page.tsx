import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import Landing from "./landing";
import DeckConsole from "./deck-console";

/**
 * nexusagenticos.com — the only front door.
 *
 * There used to be two: a public page here and the command deck at /deck, each
 * opening with its own hero and its own copy of the switchboard plate. Two
 * pages that introduce the same product is one page too many, and keeping them
 * in step meant fixing the same wrong tenant label twice.
 *
 * One URL now, and what it shows depends on who is looking: the pitch and a way
 * in for a visitor, the live console for someone signed in. No redirect either
 * way, so the address bar always reads nexusagenticos.com and a signed-in
 * operator never watches the marketing page flash past on the way to work.
 *
 * Rendered on the server so the decision is made before anything is sent. Doing
 * it client-side would ship the marketing page to an operator and swap it out
 * after hydration, which is a visible flicker and a pointless download.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);

  return session ? <DeckConsole /> : <Landing />;
}
