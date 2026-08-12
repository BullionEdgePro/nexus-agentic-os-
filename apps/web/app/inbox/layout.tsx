import { ConsoleShell } from "../console-shell";

/**
 * The inbox joins the rest of the product.
 *
 * It was the one screen with no way out except the browser's back button, and
 * the one screen that looked like a different application — near-black Tailwind
 * against vellum and ink everywhere else. Same frame now, same palette, same
 * rail.
 */
export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
