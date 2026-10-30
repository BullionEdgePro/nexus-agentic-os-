/**
 * What one row's failure means for the rest of a list (30 Oct 2026).
 *
 * Shared by the two routes that add customers row by row: the Customers
 * import and Bulk messaging's "+ Add numbers". Our own refusals ("That does
 * not look like a WhatsApp number") are thrown before any SQL and cost
 * nothing — that row is refused and the list carries on. A database error is
 * different: every /api/* request is ONE transaction, so after it Postgres
 * refuses every later row and rolls the whole request back at the end — rows
 * already reported as added included. Those errors carry a `code` (an
 * SQLSTATE, or a connection error's), and the caller must stop and say that
 * nothing was saved.
 */
export function rowFailure(err: unknown): { stop: boolean; reason: string } {
  if (err instanceof Error) return { stop: typeof (err as { code?: unknown }).code === "string", reason: err.message };
  return { stop: false, reason: "Could not add that number." };
}
