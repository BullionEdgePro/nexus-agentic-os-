import { getPool } from "./client.js";
import { withAllTenants } from "./client.js";

/**
 * Adding a business to the platform.
 *
 * Every one of the five current tenants was inserted by a hand-written
 * migration. That is fine for five and is not a platform — a system that calls
 * itself multi-tenant should be able to take a sixth business without someone
 * writing SQL and redeploying.
 *
 * THE CHECK THAT MATTERS IS NOT ON THE NEW BUSINESS.
 *
 * Everyone answers on one WhatsApp number, and routing is by keyword. So adding
 * a business is not an isolated insert: its keywords land in the same
 * namespace as everyone else's, and a word claimed by two businesses stops
 * routing either of them. Add a sixth tenant claiming "contract" and every
 * contract enquiry that used to reach the law firm starts returning a triage
 * menu instead — a regression in a business that was working, caused by
 * onboarding a different one, visible nowhere at insert time.
 *
 * So `analyseKeywordCollisions` runs first and the caller must decide. It is
 * advisory rather than fatal: some overlap is legitimate (both law firms
 * answer to "lawyer") and the switchboard's ambiguity path exists for exactly
 * that. What is not acceptable is finding out from a customer.
 */

export interface KeywordCollision {
  keyword: string;
  /** Businesses that already claim it. */
  existing: string[];
}

export async function analyseKeywordCollisions(keywords: string[]): Promise<KeywordCollision[]> {
  if (keywords.length === 0) return [];

  return withAllTenants("onboarding: keywords share one namespace", async () => {
    const { rows } = await getPool().query<{ slug: string; routing_keywords: string[] | null }>(
      `select slug, routing_keywords from organizations where is_active = true`
    );

    const normalise = (word: string) => word.trim().toLowerCase();
    const claimed = new Map<string, string[]>();
    for (const row of rows) {
      for (const keyword of row.routing_keywords ?? []) {
        const key = normalise(keyword);
        claimed.set(key, [...(claimed.get(key) ?? []), row.slug]);
      }
    }

    return keywords
      .map((keyword) => ({ keyword, existing: claimed.get(normalise(keyword)) ?? [] }))
      .filter((collision) => collision.existing.length > 0);
  });
}

export interface NewBusiness {
  slug: string;
  name: string;
  /** Meta's phone_number_id. Inherited from an existing tenant when sharing a number. */
  whatsappPhoneNumberId: string;
  whatsappBusinessAccountId: string;
  whatsappDisplayNumber: string | null;
  timezone: string;
  websiteUrl: string | null;
  routingKeywords: string[];
  systemPrompt: string;
}

export interface OnboardResult {
  organizationId: string;
  collisions: KeywordCollision[];
  /** What still has to happen before this business can serve a customer. */
  outstanding: string[];
}

/**
 * Creates the business and the agent that answers for it, in one transaction.
 *
 * Both or neither. An organization without an agent config is reachable and
 * mute: the switchboard routes a customer to it and the reply path finds no
 * agent, so the customer gets nothing and the logs show a successful route.
 */
export async function onboardBusiness(input: NewBusiness): Promise<OnboardResult> {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(input.slug)) {
    // The slug is also the deep-link tag, so it has to survive a URL and a
    // regex. Rejecting here beats discovering it when a published link fails.
    throw new Error(
      `Slug "${input.slug}" must be lowercase letters, digits and hyphens — it becomes the #tag in this business's customer link.`
    );
  }
  if (input.routingKeywords.length === 0) {
    // With no keywords the business is unreachable on a shared number: nothing
    // a customer types can route to it, and it would sit there looking live.
    throw new Error("A business on a shared number needs routing keywords, or nothing can reach it.");
  }

  const collisions = await analyseKeywordCollisions(input.routingKeywords);

  const organizationId = await withAllTenants("onboarding: creating a tenant", async () => {
    const { rows } = await getPool().query<{ id: string }>(
      `insert into organizations (
         slug, name, whatsapp_phone_number_id, whatsapp_business_account_id,
         whatsapp_display_number, timezone, website_url, routing_keywords,
         accepts_shared_number, is_number_owner, is_active
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, true, false, true)
       returning id`,
      [
        input.slug,
        input.name,
        input.whatsappPhoneNumberId,
        input.whatsappBusinessAccountId,
        input.whatsappDisplayNumber,
        input.timezone,
        input.websiteUrl,
        input.routingKeywords,
      ]
    );
    const id = rows[0].id;

    await getPool().query(
      `insert into agent_configs (organization_id, name, system_prompt, model, tools, is_active)
       values ($1, $2, $3, $4, $5, true)`,
      [
        id,
        `${input.name} Assistant`,
        input.systemPrompt,
        process.env.NEXUS_AGENT_MODEL ?? "gemini-3.5-flash",
        ["search_knowledge"],
      ]
    );

    return id;
  });

  // Assert the business is actually reachable rather than merely inserted. A
  // row that exists but cannot be found by the lookup the webhook uses is the
  // failure this codebase produces most often.
  const reachable = await withAllTenants("onboarding: verify", async () => {
    const { rows } = await getPool().query<{ n: string }>(
      `select count(*)::text as n
         from organizations o
         join agent_configs a on a.organization_id = o.id and a.is_active
        where o.id = $1 and o.is_active
          and coalesce(array_length(o.routing_keywords, 1), 0) > 0`,
      [organizationId]
    );
    return Number(rows[0].n) === 1;
  });

  if (!reachable) {
    throw new Error(
      "The business was inserted but is not reachable — no active agent, or no routing keywords. Check the row before sending anyone to it."
    );
  }

  const outstanding: string[] = [];
  if (!input.websiteUrl) {
    outstanding.push("No website recorded, so the agent has no knowledge to answer from.");
  } else {
    outstanding.push(`Index ${input.websiteUrl} on the Knowledge page, or the agent knows nothing specific.`);
  }
  if (!input.whatsappDisplayNumber) {
    outstanding.push("No dialable number, so this business has no customer link or QR code.");
  }
  outstanding.push("Publish its link and QR — nothing reaches a business nobody can find.");

  return { organizationId, collisions, outstanding };
}
