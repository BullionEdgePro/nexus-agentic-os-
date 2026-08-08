import { redirect } from "next/navigation";

/**
 * The deck lives at `/` now — it is what nexusagenticos.com shows once you are
 * signed in, rather than a second page with its own front door.
 *
 * Kept as a permanent redirect rather than deleted because this URL is already
 * in bookmarks and browser histories, and it is still what `/deck/team` sits
 * under. A 404 here would strand the people who use this every day.
 */
export default function DeckRedirect() {
  redirect("/");
}
