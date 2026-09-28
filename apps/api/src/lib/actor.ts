import type { Context } from "hono";
import { findEmployeeById, findAdminById } from "@nexus/db";
import type { SessionScope } from "./session.js";

/**
 * Who is doing this — the person behind a request, for attribution.
 *
 * `id` is what gets written into sender_id / actor columns (an employee id or an
 * admin id), `name` is what a colleague reads in the thread, and `reader` is the
 * key for per-person read state (migration 090). Human replies were written with
 * a null sender because the route read a `senderId` the client never sent — the
 * session already knew who was typing, so it is read from there, never the body.
 */
export interface Actor {
  id: string | null;
  name: string | null;
  reader: string | null;
}

/** The read-state key alone — no lookups, safe inside any tenant scope. */
export function readerOf(scope: SessionScope | undefined | null): string | null {
  if (!scope) return null;
  if (scope.role === "employee" && scope.employeeId) return `e:${scope.employeeId}`;
  return `o:${scope.adminId ?? scope.sub}`;
}

export async function actorOf(c: Context): Promise<Actor> {
  const scope = c.get("scope") as SessionScope | undefined;
  if (!scope) return { id: null, name: null, reader: null };

  if (scope.role === "employee" && scope.employeeId) {
    const employee = await findEmployeeById(scope.employeeId).catch(() => null);
    return { id: scope.employeeId, name: employee?.fullName ?? null, reader: readerOf(scope) };
  }

  const admin = scope.adminId ? await findAdminById(scope.adminId).catch(() => null) : null;
  return {
    id: scope.adminId ?? scope.sub,
    name: admin?.fullName ?? "The owner",
    reader: readerOf(scope),
  };
}
