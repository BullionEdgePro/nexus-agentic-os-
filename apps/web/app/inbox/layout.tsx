import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";
import { ConsoleShell } from "../console-shell";

/**
 * The inbox joins the rest of the product.
 *
 * It was the one screen with no way out except the browser's back button, and
 * the one screen that looked like a different application — near-black Tailwind
 * against vellum and ink everywhere else. Same frame now, same palette, same
 * rail, and the same role-aware menu as everywhere else.
 */
export const dynamic = "force-dynamic";

export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const session = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  return <ConsoleShell role={session?.role ?? "employee"}>{children}</ConsoleShell>;
}
