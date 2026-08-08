import { getPool } from "./client.js";

/**
 * A tenant reachable through a shared WhatsApp number.
 *
 * Shaped to match `RoutableBusiness` in @nexus/agents so the classifier can be
 * kept pure — it never touches the database, and these rows are the only thing
 * it is given.
 */
export interface SharedNumberBusiness {
  id: string;
  slug: string;
  name: string;
  routingKeywords: string[];
}

/**
 * Every tenant that answers on this number.
 *
 * Returns one row for a normal dedicated number and several for a shared one,
 * which is exactly the signal the processor uses to decide whether to triage at
 * all — there is no separate "is shared" flag to fall out of sync with reality.
 *
 * A tenant with no routing keywords is excluded rather than listed: it could
 * never win classification, so offering it in the menu would let a customer
 * select a business the classifier can never reach again on its own.
 */
export async function findSharedNumberBusinesses(
  phoneNumberId: string
): Promise<SharedNumberBusiness[]> {
  const { rows } = await getPool().query<{
    id: string;
    slug: string;
    name: string;
    routing_keywords: string[] | null;
  }>(
    `select id, slug, name, routing_keywords
     from organizations
     where whatsapp_phone_number_id = $1
       and is_active = true
       and accepts_shared_number = true
       and coalesce(array_length(routing_keywords, 1), 0) > 0
     order by name asc`,
    [phoneNumberId]
  );

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    routingKeywords: row.routing_keywords ?? [],
  }));
}

export interface ConversationRouting {
  routedOrganizationId: string | null;
  triagePromptedAt: string | null;
  triageAttempts: number;
}

export async function getConversationRouting(
  conversationId: string
): Promise<ConversationRouting | null> {
  const { rows } = await getPool().query<{
    routed_organization_id: string | null;
    triage_prompted_at: string | null;
    triage_attempts: number;
  }>(
    `select routed_organization_id, triage_prompted_at, triage_attempts
     from conversations
     where id = $1`,
    [conversationId]
  );
  if (!rows[0]) return null;

  return {
    routedOrganizationId: rows[0].routed_organization_id,
    triagePromptedAt: rows[0].triage_prompted_at,
    triageAttempts: Number(rows[0].triage_attempts ?? 0),
  };
}

/**
 * Pin this conversation to a business.
 *
 * Sticky by design: re-classifying every message would let one off-topic word
 * move a live conversation — and its governance policy — mid-thread. Clearing
 * the triage counters too, so a conversation that took two attempts to route
 * starts from zero if it is ever re-triaged.
 */
export async function setConversationRouting(
  conversationId: string,
  organizationId: string
): Promise<void> {
  await getPool().query(
    `update conversations
        set routed_organization_id = $2,
            routed_at = now(),
            triage_prompted_at = null,
            triage_attempts = 0
      where id = $1`,
    [conversationId, organizationId]
  );
}

/**
 * Record that the triage menu was sent.
 *
 * Called only after the message actually reaches the customer, so a send
 * failure does not burn one of the bounded attempts.
 */
export async function recordTriagePrompt(conversationId: string): Promise<void> {
  await getPool().query(
    `update conversations
        set triage_prompted_at = now(),
            triage_attempts = triage_attempts + 1
      where id = $1`,
    [conversationId]
  );
}
