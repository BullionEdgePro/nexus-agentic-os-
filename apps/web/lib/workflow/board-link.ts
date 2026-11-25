/**
 * How a link lands on the Workflow page (25 Nov 2026, final review): the view
 * it opens on, and the address once the link has been read. Pure, so the rules
 * can be tested; the page and the panels only call them.
 *
 * My board on My Day links to /deck/workflow?view=board ("Open board →") and
 * /deck/workflow?card=<id> (each "Needs me" line); an agent's pocket-listing
 * alert to /deck/workflow?view=board. The view a link asks for wins over this
 * browser's last one — a stored "Live picture" used to take the Board away, so
 * the card never opened — without becoming it: only a pick by hand is
 * remembered (3 Nov 2026). Once read, ?card= leaves the address and ?view=board
 * stays, so going back to the Board tab or reloading never opens the card
 * again, and a reload stays on the Board; a pick by hand drops ?view=.
 * Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §4, §6
 */

/** The Workflow panel's two views: the live picture, or the board staff work on. */
export type WorkflowView = "picture" | "board";

/** The view a link asks for: ?card=<id> or ?view=board is the Board; anything else asks for none. */
export function askedView(search: string): WorkflowView | undefined {
  const params = new URLSearchParams(search);
  return params.has("card") || params.get("view") === "board" ? "board" : undefined;
}

/**
 * The view the panel opens on: the one a link asked for, else this browser's
 * last ("nexus.workflow.view", which may hold anything), else the live picture.
 */
export function startView(asked: WorkflowView | undefined, stored: string | null): WorkflowView {
  if (asked) return asked;
  return stored === "picture" || stored === "board" ? stored : "picture";
}

/**
 * This address with some query parameters set (a string) or removed (null) —
 * every other one (business=) and the #hash kept — for history.replaceState;
 * null when nothing would change.
 */
export function withParams(
  where: { pathname: string; search: string; hash: string },
  changes: Record<string, string | null>
): string | null {
  const params = new URLSearchParams(where.search);
  const before = params.toString();
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  const rest = params.toString();
  if (rest === before) return null;
  return `${where.pathname}${rest ? `?${rest}` : ""}${where.hash}`;
}
