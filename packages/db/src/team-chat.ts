import { getPool } from "./client.js";

/**
 * Team chat: staff of one business talking to each other (24 Oct 2026).
 *
 * One team room per business, which every active staff member of it is in,
 * and private 1-to-1 chats between two colleagues of that business. The admin
 * reads everything and may post in the rooms; a direct chat is read-only to
 * them. Spec: docs/superpowers/specs/2026-10-24-team-chat-design.md
 *
 * Every function runs under the caller's tenant context — the route wraps its
 * work in withTenant — so RLS confines each query to one business even where
 * the WHERE names it again.
 */

export type TeamViewer =
  | { kind: "staff"; employeeId: string; organizationId: string }
  | { kind: "admin"; adminId: string; name: string };

export interface TeamThread {
  id: string;
  organizationId: string;
  kind: "room" | "direct";
  memberA: string | null;
  memberB: string | null;
}

export interface TeamMessage {
  id: string;
  threadId: string;
  authorEmployeeId: string | null;
  authorName: string;
  authorIsAdmin: boolean;
  /** Empty once removed: a removed message says so, and nothing more. */
  body: string;
  clientId: string;
  mentions: string[];
  sharedConversationId: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface ThreadSummary extends TeamThread {
  memberAName: string | null;
  memberBName: string | null;
  lastMessage: { authorName: string; body: string; createdAt: string; removed: boolean } | null;
  unread: number;
  mentioned: number;
}

/**
 * The one decision about who may read and write where. Pure, so every cell of
 * the spec's table is tested directly.
 */
export function teamAccess(thread: TeamThread, viewer: TeamViewer): { read: boolean; post: boolean } {
  if (viewer.kind === "admin") return { read: true, post: thread.kind === "room" };
  if (thread.organizationId !== viewer.organizationId) return { read: false, post: false };
  if (thread.kind === "room") return { read: true, post: true };
  const member = thread.memberA === viewer.employeeId || thread.memberB === viewer.employeeId;
  return { read: member, post: member };
}

/** A direct pair in the one order the table stores it. */
export function directPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** How a reader is keyed in team_reads. */
export function readerKey(viewer: TeamViewer): string {
  return viewer.kind === "staff" ? viewer.employeeId : `admin:${viewer.adminId}`;
}

interface ThreadRow {
  id: string;
  organization_id: string;
  kind: "room" | "direct";
  member_a: string | null;
  member_b: string | null;
}

const toThread = (row: ThreadRow): TeamThread => ({
  id: row.id,
  organizationId: row.organization_id,
  kind: row.kind,
  memberA: row.member_a,
  memberB: row.member_b,
});

interface MessageRow {
  id: string;
  thread_id: string;
  author_employee_id: string | null;
  author_name: string;
  author_is_admin: boolean;
  body: string;
  client_id: string;
  mentions: string[] | null;
  shared_conversation_id: string | null;
  created_at: Date | string;
  deleted_at: Date | string | null;
}

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);

const toMessage = (row: MessageRow): TeamMessage => ({
  id: row.id,
  threadId: row.thread_id,
  authorEmployeeId: row.author_employee_id,
  authorName: row.author_name,
  authorIsAdmin: row.author_is_admin,
  body: row.deleted_at ? "" : row.body,
  clientId: row.client_id,
  mentions: row.mentions ?? [],
  sharedConversationId: row.deleted_at ? null : row.shared_conversation_id,
  createdAt: iso(row.created_at),
  deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
});

const MESSAGE_COLUMNS = `id, thread_id, author_employee_id, author_name, author_is_admin, body, client_id,
  mentions, shared_conversation_id, created_at, deleted_at`;

/** The business's room, created the first time anybody opens team chat. */
export async function ensureRoom(organizationId: string): Promise<TeamThread> {
  await getPool().query(
    `insert into team_threads (organization_id, kind) values ($1, 'room')
     on conflict (organization_id) where kind = 'room' do nothing`,
    [organizationId]
  );
  const { rows } = await getPool().query<ThreadRow>(
    `select id, organization_id, kind, member_a, member_b
       from team_threads where organization_id = $1 and kind = 'room'`,
    [organizationId]
  );
  return toThread(rows[0]!);
}

/** The one direct thread between two colleagues, made on first use. */
export async function getOrCreateDirect(organizationId: string, a: string, b: string): Promise<TeamThread> {
  const [first, second] = directPair(a, b);
  await getPool().query(
    `insert into team_threads (organization_id, kind, member_a, member_b) values ($1, 'direct', $2, $3)
     on conflict (organization_id, member_a, member_b) where kind = 'direct' do nothing`,
    [organizationId, first, second]
  );
  const { rows } = await getPool().query<ThreadRow>(
    `select id, organization_id, kind, member_a, member_b
       from team_threads
      where organization_id = $1 and kind = 'direct' and member_a = $2 and member_b = $3`,
    [organizationId, first, second]
  );
  return toThread(rows[0]!);
}

export async function findThread(id: string): Promise<TeamThread | null> {
  const { rows } = await getPool().query<ThreadRow>(
    `select id, organization_id, kind, member_a, member_b from team_threads where id = $1`,
    [id]
  );
  return rows[0] ? toThread(rows[0]) : null;
}

/**
 * The threads a viewer may read in one business, room first, each with its
 * last message and what is unread for this reader. A message is unread when
 * it came after the reader's mark, was not written by them, and still stands.
 */
export async function listThreadSummaries(organizationId: string, viewer: TeamViewer): Promise<ThreadSummary[]> {
  await ensureRoom(organizationId);
  const employeeId = viewer.kind === "staff" ? viewer.employeeId : null;
  const { rows } = await getPool().query<
    ThreadRow & {
      member_a_name: string | null;
      member_b_name: string | null;
      last_author: string | null;
      last_body: string | null;
      last_at: Date | string | null;
      last_removed: boolean | null;
      unread: string;
      mentioned: string;
    }
  >(
    `select t.id, t.organization_id, t.kind, t.member_a, t.member_b,
            ea.full_name as member_a_name, eb.full_name as member_b_name,
            lm.author_name as last_author, left(lm.body, 200) as last_body, lm.created_at as last_at,
            lm.deleted_at is not null as last_removed,
            (select count(*) from team_messages m
              where m.thread_id = t.id and m.deleted_at is null
                and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
                and ${employeeId ? "m.author_employee_id is distinct from $3::uuid" : "not m.author_is_admin"}
            ) as unread,
            (select count(*) from team_messages m
              where m.thread_id = t.id and m.deleted_at is null
                and m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
                and $3::uuid = any(m.mentions)
            ) as mentioned
       from team_threads t
       left join employees ea on ea.id = t.member_a
       left join employees eb on eb.id = t.member_b
       left join team_reads r on r.thread_id = t.id and r.reader = $2
       left join lateral (
         select author_name, body, created_at, deleted_at from team_messages
          where thread_id = t.id order by created_at desc limit 1
       ) lm on true
      where t.organization_id = $1
        and (t.kind = 'room' or $3::uuid is null or $3::uuid in (t.member_a, t.member_b))
      order by (t.kind = 'room') desc, coalesce(lm.created_at, t.created_at) desc`,
    [organizationId, readerKey(viewer), employeeId]
  );
  return rows.map((row) => ({
    ...toThread(row),
    memberAName: row.member_a_name,
    memberBName: row.member_b_name,
    lastMessage: row.last_at
      ? {
          authorName: row.last_author ?? "",
          body: row.last_removed ? "" : (row.last_body ?? ""),
          createdAt: iso(row.last_at),
          removed: Boolean(row.last_removed),
        }
      : null,
    unread: Number(row.unread),
    mentioned: Number(row.mentioned),
  }));
}

/** One page of a thread, oldest first; `before` pages back in time. */
export async function listTeamMessages(threadId: string, before: string | null, limit: number): Promise<TeamMessage[]> {
  const { rows } = await getPool().query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from team_messages
      where thread_id = $1 and ($2::timestamptz is null or created_at < $2::timestamptz)
      order by created_at desc
      limit $3`,
    [threadId, before, Math.min(Math.max(limit, 1), 100)]
  );
  return rows.map(toMessage).reverse();
}

/**
 * Save a message. A second send with the same clientId (a retry after a
 * dropped connection) returns the first one instead of saving it twice.
 */
export async function postTeamMessage(input: {
  thread: TeamThread;
  authorEmployeeId: string | null;
  authorName: string;
  authorIsAdmin: boolean;
  body: string;
  clientId: string;
  mentions: string[];
  sharedConversationId: string | null;
}): Promise<{ message: TeamMessage; created: boolean }> {
  const inserted = await getPool().query<MessageRow>(
    `insert into team_messages
       (thread_id, organization_id, author_employee_id, author_name, author_is_admin, body, client_id,
        mentions, shared_conversation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (thread_id, client_id) do nothing
     returning ${MESSAGE_COLUMNS}`,
    [
      input.thread.id,
      input.thread.organizationId,
      input.authorEmployeeId,
      input.authorName.slice(0, 120),
      input.authorIsAdmin,
      input.body,
      input.clientId,
      input.mentions,
      input.sharedConversationId,
    ]
  );
  if (inserted.rows[0]) return { message: toMessage(inserted.rows[0]), created: true };
  const { rows } = await getPool().query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from team_messages where thread_id = $1 and client_id = $2`,
    [input.thread.id, input.clientId]
  );
  return { message: toMessage(rows[0]!), created: false };
}

export async function markTeamRead(thread: TeamThread, reader: string): Promise<void> {
  await getPool().query(
    `insert into team_reads (thread_id, organization_id, reader, last_read_at) values ($1, $2, $3, now())
     on conflict (thread_id, reader) do update set last_read_at = now()`,
    [thread.id, thread.organizationId, reader]
  );
}

/** When a reader last read a thread — "Seen" under a direct message. */
export async function lastReadBy(threadId: string, reader: string): Promise<string | null> {
  const { rows } = await getPool().query<{ last_read_at: Date | string }>(
    `select last_read_at from team_reads where thread_id = $1 and reader = $2`,
    [threadId, reader]
  );
  return rows[0] ? iso(rows[0].last_read_at) : null;
}

/** The author removes their own message. Null when it is not theirs or already gone. */
export async function removeTeamMessage(id: string, employeeId: string): Promise<TeamMessage | null> {
  const { rows } = await getPool().query<MessageRow>(
    `update team_messages set deleted_at = now()
      where id = $1 and author_employee_id = $2 and deleted_at is null
      returning ${MESSAGE_COLUMNS}`,
    [id, employeeId]
  );
  return rows[0] ? toMessage(rows[0]) : null;
}

/** Everything unread for a viewer in one business — the sidebar badge. */
export async function teamUnread(organizationId: string, viewer: TeamViewer): Promise<{ unread: number; mentioned: number }> {
  const threads = await listThreadSummaries(organizationId, viewer);
  return {
    unread: threads.reduce((sum, t) => sum + t.unread, 0),
    mentioned: threads.reduce((sum, t) => sum + t.mentioned, 0),
  };
}

/**
 * The customer behind each handed-over chat: name and channel, for the card.
 * Read cross-tenant, like findConversationById — on a shared number a chat is
 * owned by the number's business and served by another, and the caller has
 * already settled who may see it.
 */
export async function sharedConversationCards(
  ids: string[]
): Promise<Map<string, { name: string; channel: string }>> {
  if (ids.length === 0) return new Map();
  const { rows } = await getPool().query<{ id: string; name: string | null; channel: string }>(
    `select c.id, coalesce(ct.display_name, ct.external_id, '+' || ct.wa_id) as name,
            coalesce(c.channel, 'whatsapp') as channel
       from conversations c join contacts ct on ct.id = c.contact_id
      where c.id = any($1::uuid[])`,
    [ids]
  );
  return new Map(rows.map((row) => [row.id, { name: row.name ?? "Customer", channel: row.channel }]));
}
