import { getPool } from "@nexus/db";

export interface KnowledgeSourceSummary {
  id: string;
  kind: string;
  title: string;
  uri: string | null;
  status: string;
  version: number;
  chunks: number;
  lastIndexedAt: string | null;
  lastCheckedAt: string | null;
  error: string | null;
}

/**
 * List a tenant's knowledge sources with their health.
 *
 * Returns `status`, `error` and the freshness timestamps rather than just
 * titles, because the questions an operator actually has are "is this indexed",
 * "why did that one fail" and "how stale is it" — a bare list answers none of
 * them and makes a broken source look identical to a working one.
 */
export async function listKnowledgeSources(
  organizationId: string
): Promise<KnowledgeSourceSummary[]> {
  const { rows } = await getPool().query<{
    id: string;
    kind: string;
    title: string;
    uri: string | null;
    status: string;
    version: number;
    chunks: string;
    last_indexed_at: string | null;
    last_checked_at: string | null;
    error: string | null;
  }>(
    `select s.id, s.kind, s.title, s.uri, s.status, s.version,
            count(c.id)::text as chunks,
            s.last_indexed_at, s.last_checked_at, s.error
     from knowledge_sources s
     left join knowledge_chunks c on c.source_id = s.id
     where s.organization_id = $1
     group by s.id
     order by s.created_at desc`,
    [organizationId]
  );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    uri: row.uri,
    status: row.status,
    version: row.version,
    chunks: Number(row.chunks),
    lastIndexedAt: row.last_indexed_at,
    lastCheckedAt: row.last_checked_at,
    error: row.error,
  }));
}

/**
 * Delete a source and its chunks.
 *
 * Scoped by organization as well as id: an operator today sees every tenant, so
 * a bare id lookup would let a mistyped request delete another business's
 * knowledge. Returns false when nothing matched so the caller can 404 rather
 * than report a successful no-op.
 */
export async function deleteKnowledgeSource(
  organizationId: string,
  sourceId: string
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `delete from knowledge_sources where id = $1 and organization_id = $2`,
    [sourceId, organizationId]
  );
  return (rowCount ?? 0) > 0;
}
