import { getPool } from "./client.js";

/**
 * A business's saved replies — the library behind the composer's quick-reply
 * picker. Every function runs under the request's tenant context (the route
 * sits at /api/organizations/:slug/*, which the tenant middleware wraps in
 * withTenant), so RLS scopes each query to the one org without it being named
 * again in the WHERE — the explicit organization_id is belt-and-suspenders.
 */
export interface QuickReply {
  id: string;
  title: string;
  body: string;
  createdBy: string | null;
  createdAt: string;
}

interface QuickReplyRow {
  id: string;
  title: string;
  body: string;
  created_by: string | null;
  created_at: string;
}

const toQuickReply = (r: QuickReplyRow): QuickReply => ({
  id: r.id,
  title: r.title,
  body: r.body,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/** A business's quick replies, newest first. */
export async function listQuickReplies(organizationId: string): Promise<QuickReply[]> {
  const { rows } = await getPool().query<QuickReplyRow>(
    `select id, title, body, created_by, created_at
       from quick_replies
      where organization_id = $1
      order by created_at desc`,
    [organizationId]
  );
  return rows.map(toQuickReply);
}

/** Save a new quick reply for a business. */
export async function createQuickReply(input: {
  organizationId: string;
  title: string;
  body: string;
  createdBy: string | null;
}): Promise<QuickReply> {
  const { rows } = await getPool().query<QuickReplyRow>(
    `insert into quick_replies (organization_id, title, body, created_by)
     values ($1, $2, $3, $4)
     returning id, title, body, created_by, created_at`,
    [input.organizationId, input.title, input.body, input.createdBy]
  );
  return toQuickReply(rows[0]);
}

/**
 * Delete one. Returns whether a row went — the org id is passed as well as the
 * id so a stray id from another business (which RLS would already hide) cannot
 * report a delete that did not happen.
 */
export async function deleteQuickReply(organizationId: string, id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `delete from quick_replies where id = $1 and organization_id = $2`,
    [id, organizationId]
  );
  return (rowCount ?? 0) > 0;
}
