import { getPool } from "@nexus/db";
import type { LeadAssessment } from "./score.js";

export interface RecordLeadInput extends LeadAssessment {
  organizationId: string;
  contactId: string;
  conversationId?: string | null;
  messageId?: string | null;
}

/**
 * Persist an assessment: append the audit row, then refresh the contact's
 * current standing.
 *
 * Written as two statements rather than one so the history is never lost even
 * if the denormalized update fails — the assessment log is the record of
 * record, and the columns on `contacts` are a cache for sorting an inbox.
 */
export async function recordLeadAssessment(input: RecordLeadInput): Promise<void> {
  const pool = getPool();

  await pool.query(
    `insert into lead_assessments
       (organization_id, contact_id, conversation_id, message_id, score, priority, category, signals)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.organizationId,
      input.contactId,
      input.conversationId ?? null,
      input.messageId ?? null,
      input.score,
      input.priority,
      input.category,
      JSON.stringify(input.signals),
    ]
  );

  // Keep the highest score this contact has ever reached rather than the most
  // recent. Someone who asked about a bulk order last week and "thanks" today
  // is still the bulk-order lead; letting a trailing pleasantry reset them to
  // zero would quietly bury the most valuable contacts in the list.
  await pool.query(
    `update contacts
     set lead_score = greatest(coalesce(lead_score, 0), $2),
         lead_priority = case
           when coalesce(lead_score, 0) >= $2 then lead_priority
           else $3
         end,
         lead_category = case
           when coalesce(lead_score, 0) >= $2 then lead_category
           else $4
         end,
         lead_updated_at = now()
     where id = $1`,
    [input.contactId, input.score, input.priority, input.category]
  );
}

/** Inbound messages this contact has sent before now — the returning-contact signal. */
export async function countPriorInbound(contactId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(*)::text as count from messages
     where contact_id = $1 and direction = 'inbound'`,
    [contactId]
  );
  return Number(rows[0]?.count ?? 0);
}
