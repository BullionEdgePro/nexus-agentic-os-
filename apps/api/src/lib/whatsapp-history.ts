import type { WhatsAppHistoryChunk, WhatsAppWebhookEntry } from "@nexus/shared";
import {
  claimForAutoAssign,
  findEmployeeByPhoneNumberId,
  importHistoryThread,
  nameContactIfUnnamed,
  setConversationPhoneNumber,
  withTenant,
} from "@nexus/db";
import { getRedisConnection } from "../queue/queue.js";
import { requestSmbAppData } from "./whatsapp-client.js";
import { describeInboundMessage } from "./inbound-media.js";
import { logger } from "./logger.js";

/**
 * A staff member's past chats, brought in from their WhatsApp Business app.
 *
 * ============================================================
 * WHY THEIR OLD CHATS NEVER APPEARED
 * ============================================================
 *
 * Connecting a WhatsApp Business app number (Coexistence) moves nothing by
 * itself. Meta sends up to 180 days of one-to-one chats only when the platform
 * ASKS — `smb_app_data` with sync_type "history", within 24 hours of the
 * connect and once per connection — and then delivers them as `history`
 * webhooks. Nexus did neither until 28 Oct 2026: it never asked, and the
 * webhook processor read only `messages`, `statuses` and `message_echoes`, so a
 * history chunk would have been dropped anyway. Staff connected and found an
 * empty inbox for clients they had talked to for months.
 *
 * Now the connect asks for the contact book and the history straight away, the
 * processor imports each chunk (see importHistoryThread: original times,
 * deduped, never answered), and the progress is kept here so Connections can
 * say what happened — including "you turned sharing off", which Meta reports as
 * error 2593109 instead of history.
 */

export type HistoryState = "requested" | "importing" | "done" | "declined" | "refused";

export interface HistoryStatus {
  state: HistoryState;
  requestedAt: string | null;
  progress: number;
  imported: number;
  chats: number;
  error: string | null;
  updatedAt: string;
}

const KEY = (phoneNumberId: string) => `wa-history:${phoneNumberId}`;
const NAMES = (phoneNumberId: string) => `wa-contact-names:${phoneNumberId}`;
// Long enough to outlive any import and still answer "what happened" a while
// later; it is a progress note, not a record — the messages are the record.
const TTL_SECONDS = 60 * 86_400;

/** Meta's code for "the business turned history sharing off in the app". */
export const HISTORY_SHARING_OFF = 2593109;

export async function readHistoryStatus(phoneNumberId: string): Promise<HistoryStatus | null> {
  const raw = await getRedisConnection().get(KEY(phoneNumberId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HistoryStatus;
  } catch {
    return null;
  }
}

async function writeHistoryStatus(phoneNumberId: string, status: HistoryStatus): Promise<void> {
  await getRedisConnection().set(KEY(phoneNumberId), JSON.stringify(status), "EX", TTL_SECONDS);
}

async function updateHistoryStatus(phoneNumberId: string, change: (current: HistoryStatus) => HistoryStatus): Promise<void> {
  const current = (await readHistoryStatus(phoneNumberId)) ?? {
    state: "importing" as const,
    requestedAt: null,
    progress: 0,
    imported: 0,
    chats: 0,
    error: null,
    updatedAt: new Date().toISOString(),
  };
  await writeHistoryStatus(phoneNumberId, { ...change(current), updatedAt: new Date().toISOString() });
}

/**
 * Ask Meta for the contact book and the chat history of a number just
 * connected. Contacts first, as Meta's own steps order them, so names are known
 * when the threads arrive. Never throws: a connect that worked must not be
 * reported as failed because the history request did not.
 */
export async function requestChatHistory(phoneNumberId: string, accessToken?: string): Promise<HistoryStatus> {
  const contacts = await requestSmbAppData(phoneNumberId, "smb_app_state_sync", accessToken);
  if (!contacts.ok) logger.warn({ phoneNumberId, err: contacts.error }, "Contact book sync was not accepted");
  const history = await requestSmbAppData(phoneNumberId, "history", accessToken);
  const now = new Date().toISOString();
  const status: HistoryStatus = history.ok
    ? { state: "requested", requestedAt: now, progress: 0, imported: 0, chats: 0, error: null, updatedAt: now }
    : { state: "refused", requestedAt: now, progress: 0, imported: 0, chats: 0, error: history.error, updatedAt: now };
  await writeHistoryStatus(phoneNumberId, status).catch((err) =>
    logger.warn({ err, phoneNumberId }, "Could not note the history request")
  );
  logger.info(
    { phoneNumberId, accepted: history.ok, requestId: history.ok ? history.requestId : null, err: history.ok ? null : history.error },
    "Asked WhatsApp for a connected number's chat history"
  );
  return status;
}

/** A message's history status as the messages table spells it. */
export function historyMessageStatus(status: string | undefined): "sent" | "delivered" | "read" | "failed" {
  switch ((status ?? "").toUpperCase()) {
    case "READ":
    case "PLAYED":
      return "read";
    case "DELIVERED":
      return "delivered";
    case "ERROR":
      return "failed";
    default:
      return "sent";
  }
}

/** The line a history message shows as. Exported for its test. */
export function historyMessageBody(message: { type: string; [key: string]: unknown }): string {
  if (message.type === "media_placeholder") return "📎 A photo, video or file (not included in the imported history)";
  const described = describeInboundMessage(message as Parameters<typeof describeInboundMessage>[0]);
  return described?.body ?? `[${message.type || "message"}]`;
}

const digits = (value: string | undefined | null) => (value ?? "").replace(/\D/g, "");

/**
 * One history chunk, written. Threads are imported one at a time so a bad one
 * costs that thread, never the chunk — Meta does not resend a chunk the
 * platform answered 200 for.
 */
async function importChunk(
  phoneNumberId: string,
  employee: { id: string; organizationId: string; fullName: string },
  chunk: WhatsAppHistoryChunk
): Promise<void> {
  const sharingOff = chunk.errors?.find((error) => error.code === HISTORY_SHARING_OFF);
  if (sharingOff || chunk.errors?.length) {
    const error = chunk.errors?.[0];
    await updateHistoryStatus(phoneNumberId, (current) => ({
      ...current,
      state: sharingOff ? "declined" : current.state,
      error: `${error?.code ?? ""}: ${error?.message ?? error?.title ?? "history was not shared"}`,
    }));
    logger.warn({ phoneNumberId, errors: chunk.errors }, "WhatsApp sent no history for a connected number");
    return;
  }

  let imported = 0;
  let chats = 0;
  for (const thread of chunk.threads ?? []) {
    const customer = digits(thread.id);
    if (!customer) continue;
    try {
      const messages = (thread.messages ?? [])
        .filter((message) => message?.id && message.timestamp)
        .map((message) => ({
          waMessageId: String(message.id),
          // A message is the customer's when it came FROM the thread's number;
          // everything else in the thread was sent by the business.
          direction: digits(message.from) === customer ? ("inbound" as const) : ("outbound" as const),
          messageType: String(message.type || "text"),
          body: historyMessageBody(message),
          at: new Date(Number(message.timestamp) * 1000).toISOString(),
          status: historyMessageStatus(message.history_context?.status),
          rawPayload: message,
        }));
      if (messages.length === 0) continue;
      const name = await getRedisConnection().hget(NAMES(phoneNumberId), customer).catch(() => null);
      const result = await importHistoryThread({
        organizationId: employee.organizationId,
        contactWaId: customer,
        contactName: name,
        onNumber: phoneNumberId,
        employeeId: employee.id,
        messages,
      });
      // A chat on their own number is theirs, as a live message there makes it —
      // and only if nobody has it, so history never takes a chat from a colleague.
      await withTenant(employee.organizationId, async () => {
        await setConversationPhoneNumber(result.conversationId, phoneNumberId);
        await claimForAutoAssign(result.conversationId, employee.id, employee.fullName);
      });
      imported += result.inserted;
      chats++;
    } catch (err) {
      logger.error({ err, phoneNumberId, thread: thread.id }, "Could not import one history thread");
    }
  }

  const progress = Number(chunk.metadata?.progress ?? 0);
  await updateHistoryStatus(phoneNumberId, (current) => ({
    ...current,
    state: progress >= 100 ? "done" : "importing",
    progress: Math.max(current.progress, Number.isFinite(progress) ? progress : 0),
    imported: current.imported + imported,
    chats: current.chats + chats,
  }));
  logger.info(
    { phoneNumberId, phase: chunk.metadata?.phase, chunk: chunk.metadata?.chunk_order, progress, imported, chats },
    "Imported a chunk of a staff member's WhatsApp history"
  );
}

/**
 * The `history` and `smb_app_state_sync` halves of a webhook change. Only ever
 * acts on a number that belongs to a staff member — Coexistence is per person.
 */
export async function processAppSync(phoneNumberId: string, change: WhatsAppWebhookEntry["changes"][number]): Promise<void> {
  const history = change.value.history ?? [];
  const contacts = change.value.state_sync ?? [];
  if (history.length === 0 && contacts.length === 0) return;

  const employee = await findEmployeeByPhoneNumberId(phoneNumberId);
  if (!employee) {
    logger.warn({ phoneNumberId, field: change.field }, "App sync for a number that is no staff member's — ignored");
    return;
  }

  // Names first: a chunk in the same delivery can then use them.
  for (const entry of contacts) {
    const waId = digits(entry.contact?.phone_number);
    const name = entry.contact?.full_name?.trim() || entry.contact?.first_name?.trim();
    if (!waId || entry.action === "remove" || !name) continue;
    try {
      await getRedisConnection().hset(NAMES(phoneNumberId), waId, name);
      await getRedisConnection().expire(NAMES(phoneNumberId), TTL_SECONDS);
      await nameContactIfUnnamed(employee.organizationId, waId, name);
    } catch (err) {
      logger.warn({ err, phoneNumberId }, "Could not record a contact name from the app's book");
    }
  }

  for (const chunk of history) {
    await importChunk(phoneNumberId, employee, chunk);
  }
}
