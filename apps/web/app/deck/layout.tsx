import { ConsoleShell } from "../console-shell";

/**
 * Every /deck/* screen now sits inside the shared console frame.
 *
 * A nested layout rather than a wrapper each page imports, because the point is
 * that a page cannot forget. Nine screens shipped without navigation precisely
 * because adding it was each page's own responsibility.
 */
export default function DeckLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
