import { getPool } from "./client.js";
import { TEAM_MESSAGE_COLUMNS, toTeamMessage, type TeamMessage, type TeamMessageRow, type TeamThread } from "./team-chat.js";

/**
 * Team chat's voice notes, photos, files, replies and reactions (2 Nov 2026,
 * migration 104). Spec: docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md
 *
 * The bytes live in `team_files`, under the same tenant policy as the messages,
 * and are never returned by anything here except `teamFileBytes`: every list,
 * page and live event carries the description of a file, not the file.
 *
 * Like team-chat.ts, every function runs under the caller's tenant context.
 */

export type TeamFileKind = "voice" | "photo" | "file";

export interface TeamFileMeta {
  id: string;
  threadId: string;
  kind: TeamFileKind;
  mime: string;
  name: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  waveform: number[] | null;
  deletedAt: string | null;
}

export interface TeamReaction {
  emoji: string;
  by: Array<{ key: string; name: string }>;
}

interface FileRow {
  id: string;
  thread_id: string;
  kind: TeamFileKind;
  mime: string;
  name: string;
  size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  waveform: number[] | null;
  deleted_at: Date | string | null;
}

const FILE_COLUMNS = "id, thread_id, kind, mime, name, size, width, height, duration_ms, waveform, deleted_at";

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);

const toMeta = (row: FileRow): TeamFileMeta => ({
  id: row.id,
  threadId: row.thread_id,
  kind: row.kind,
  mime: row.mime,
  name: row.name,
  size: Number(row.size),
  width: row.width,
  height: row.height,
  durationMs: row.duration_ms,
  waveform: row.waveform ? row.waveform.map(Number) : null,
  deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
});

/** Store a file for a message about to be posted in the same transaction. */
export async function saveTeamFile(input: {
  thread: TeamThread;
  uploader: string;
  kind: TeamFileKind;
  mime: string;
  name: string;
  bytes: Uint8Array;
  preview: Uint8Array | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  waveform: number[] | null;
}): Promise<TeamFileMeta> {
  const { rows } = await getPool().query<FileRow>(
    `insert into team_files
       (organization_id, thread_id, uploader, kind, mime, name, size, bytes, preview, width, height, duration_ms, waveform)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning ${FILE_COLUMNS}`,
    [
      input.thread.organizationId,
      input.thread.id,
      input.uploader,
      input.kind,
      input.mime,
      input.name,
      input.bytes.byteLength,
      Buffer.from(input.bytes),
      input.preview ? Buffer.from(input.preview) : null,
      input.width,
      input.height,
      input.durationMs,
      input.waveform,
    ]
  );
  return toMeta(rows[0]!);
}

/** Descriptions of files by id, removed ones included (marked by deletedAt). */
export async function teamFileMeta(ids: string[]): Promise<Map<string, TeamFileMeta>> {
  if (ids.length === 0) return new Map();
  const { rows } = await getPool().query<FileRow>(
    `select ${FILE_COLUMNS} from team_files where id = any($1::uuid[])`,
    [ids]
  );
  return new Map(rows.map((row) => [row.id, toMeta(row)]));
}

/** A file's bytes or its preview; null when missing, removed, or it has no preview. */
export async function teamFileBytes(
  id: string,
  which: "bytes" | "preview"
): Promise<{ meta: TeamFileMeta; bytes: Uint8Array<ArrayBuffer> } | null> {
  const column = which === "preview" ? "preview" : "bytes";
  const { rows } = await getPool().query<FileRow & { data: Buffer | null }>(
    `select ${FILE_COLUMNS}, ${column} as data from team_files
      where id = $1 and deleted_at is null and ${column} is not null`,
    [id]
  );
  const row = rows[0];
  if (!row || !row.data) return null;
  return { meta: toMeta(row), bytes: new Uint8Array(row.data) };
}

/** The message a clientId already landed as: a retried send returns it instead of storing twice. */
export async function findMessageByClientId(threadId: string, clientId: string): Promise<TeamMessage | null> {
  const { rows } = await getPool().query<TeamMessageRow>(
    `select ${TEAM_MESSAGE_COLUMNS} from team_messages where thread_id = $1 and client_id = $2`,
    [threadId, clientId]
  );
  return rows[0] ? toTeamMessage(rows[0]) : null;
}

/** Messages by id — the originals that replies quote, which may be older than the page. */
export async function teamMessagesByIds(ids: string[]): Promise<Map<string, TeamMessage>> {
  if (ids.length === 0) return new Map();
  const { rows } = await getPool().query<TeamMessageRow>(
    `select ${TEAM_MESSAGE_COLUMNS} from team_messages where id = any($1::uuid[])`,
    [ids]
  );
  return new Map(rows.map((row) => [row.id, toTeamMessage(row)]));
}

/** One reaction per person per message: a second emoji replaces the first. */
export async function setTeamReaction(input: {
  thread: TeamThread;
  messageId: string;
  reactor: string;
  reactorName: string;
  emoji: string;
}): Promise<void> {
  await getPool().query(
    `insert into team_reactions (message_id, organization_id, reactor, reactor_name, emoji)
     values ($1, $2, $3, $4, $5)
     on conflict (message_id, reactor) do update
       set emoji = excluded.emoji, reactor_name = excluded.reactor_name, created_at = now()`,
    [input.messageId, input.thread.organizationId, input.reactor, input.reactorName.slice(0, 120), input.emoji]
  );
}

export async function removeTeamReaction(messageId: string, reactor: string): Promise<void> {
  await getPool().query(`delete from team_reactions where message_id = $1 and reactor = $2`, [messageId, reactor]);
}

export async function reactionsFor(messageIds: string[]): Promise<Map<string, TeamReaction[]>> {
  if (messageIds.length === 0) return new Map();
  const { rows } = await getPool().query<{
    message_id: string;
    emoji: string;
    reactor: string;
    reactor_name: string;
    created_at: Date | string;
  }>(
    `select message_id, emoji, reactor, reactor_name, created_at from team_reactions
      where message_id = any($1::uuid[])`,
    [messageIds]
  );
  return groupReactions(rows);
}

/**
 * Reactions per message: each emoji once, in the order it was first used,
 * with the people in the order they reacted. Pure.
 */
export function groupReactions(
  rows: Array<{ message_id: string; emoji: string; reactor: string; reactor_name: string; created_at: Date | string }>
): Map<string, TeamReaction[]> {
  const sorted = [...rows].sort((a, b) => Date.parse(iso(a.created_at)) - Date.parse(iso(b.created_at)));
  const out = new Map<string, TeamReaction[]>();
  for (const row of sorted) {
    const list = out.get(row.message_id) ?? [];
    let group = list.find((g) => g.emoji === row.emoji);
    if (!group) {
      group = { emoji: row.emoji, by: [] };
      list.push(group);
    }
    group.by.push({ key: row.reactor, name: row.reactor_name });
    out.set(row.message_id, list);
  }
  return out;
}

const QUOTE_MAX = 120;

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const cut = (text: string) => [...text].slice(0, QUOTE_MAX).join("");

/** What a reply's quote says about the message it answers. Pure. */
export function replySnippet(
  message: { body: string; deletedAt: string | null },
  file: { kind: TeamFileKind; name: string; durationMs?: number | null } | null
): { snippet: string; removed: boolean } {
  if (message.deletedAt) return { snippet: "Message removed", removed: true };
  const body = message.body.trim();
  if (file?.kind === "voice") return { snippet: `🎤 Voice note ${clock(file.durationMs ?? 0)}`, removed: false };
  if (file?.kind === "photo") return { snippet: cut(`📷 ${body || "Photo"}`), removed: false };
  if (file?.kind === "file") return { snippet: cut(`📄 ${file.name}`), removed: false };
  return { snippet: cut(body), removed: false };
}

/**
 * When everybody in a room has read up to: the earliest mark among the
 * business's active staff. Null for a direct chat (it has seenByOther), and
 * while anyone in the room has never opened it.
 */
export async function seenByAllAt(thread: TeamThread): Promise<string | null> {
  if (thread.kind !== "room") return null;
  const { rows } = await getPool().query<{ members: string; unread_ever: string; earliest: Date | string | null }>(
    `select count(*) as members,
            count(*) filter (where r.last_read_at is null) as unread_ever,
            min(r.last_read_at) as earliest
       from employees e
       left join team_reads r on r.thread_id = $1 and r.reader = e.id::text
      where e.organization_id = $2 and e.is_active`,
    [thread.id, thread.organizationId]
  );
  const row = rows[0];
  if (!row || Number(row.members) === 0 || Number(row.unread_ever) > 0 || !row.earliest) return null;
  return iso(row.earliest);
}
