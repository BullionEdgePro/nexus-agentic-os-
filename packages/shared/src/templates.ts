/**
 * Which business a WhatsApp template speaks for.
 *
 * ============================================================
 * WHY THIS HAS TO EXIST
 * ============================================================
 *
 * Templates live on the WhatsApp Business Account, and five businesses share
 * one. So a sync run for ABR pulls back every template on the account — its
 * own, the other four businesses', and any left there by another integration —
 * and writes a row for each under ABR's `organization_id`. Measured on
 * production 2026-08-26: 35 rows, which is 7 templates times 5 businesses, all
 * APPROVED, all sendable.
 *
 * That means a broadcast from a law firm to a law firm's clients could go out
 * templated as `zipicka_order_update` — "There is an update on your order with
 * us" — and nothing would refuse it. Meta approved it, the row is real, the
 * audience is right, and the message is from the wrong company. This is the
 * shared-number defect this codebase keeps meeting, arriving through the one
 * door where the output is a message a customer actually receives.
 *
 * Meta cannot help: it knows one account, not five tenants. The attribution has
 * to come from here, and here is the only place it is written down — the
 * provisioning script imports this rather than keeping its own copy, because a
 * list describing the same five businesses is one fact.
 *
 * ============================================================
 * WHAT ABOUT A TEMPLATE NOBODY HERE MADE
 * ============================================================
 *
 * `klaviyo_default_helpdesk_template` and `klaviyo_double_optin` are on the
 * account and were not created by this platform. They are NOT hidden, and that
 * is deliberate: hiding every unattributed template would make one created by
 * hand in Meta's console invisible with no explanation, and somebody would
 * reasonably conclude the sync was broken.
 *
 * So attribution has three answers, not two — this business's, another
 * business's, and unknown — and only the middle one is refused.
 */

/**
 * The templates this platform provisions for each business.
 *
 * A LIST PER BUSINESS, not one name. It was one name while every business had
 * exactly one utility template, and the first marketing template made that
 * false. The shape mattered more than it looked: a template absent from this
 * map is "unattributed", which is the PERMISSIVE answer -- sendable by every
 * business on the shared account. So the map growing a second entry for one
 * business had to be possible, or the second template would have been added to
 * the provisioning script alone and quietly become everybody's.
 */
export const PROVISIONED_TEMPLATE_BY_SLUG: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    zipicka: ["zipicka_order_update", "zipicka_promotions"],
    "sfs-international": ["sfs_property_update"],
    "juris-prime": ["juris_prime_attestation_update"],
    "juris-prime-legal": ["juris_prime_legal_update"],
    abr: ["abr_matter_update"],
  });

/** Reverse of the above, built once. */
const SLUG_BY_TEMPLATE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVISIONED_TEMPLATE_BY_SLUG).flatMap(([slug, names]) =>
      names.map((name) => [name, slug])
    )
  )
);

/**
 * The business a template name was provisioned for, or null if nobody here
 * created it.
 *
 * Null is not "safe to send" and not "unsafe" — it is "this platform does not
 * know", which the caller has to decide about rather than assume.
 */
export function templateOwnerSlug(metaTemplateName: string): string | null {
  return SLUG_BY_TEMPLATE[metaTemplateName] ?? null;
}

export type TemplateAttribution = "own" | "other-business" | "unattributed";

/**
 * Whether `slug` may send under `metaTemplateName`.
 *
 * The only refusal is a template positively known to belong to someone else.
 * Nothing is refused for being unrecognised, because an unrecognised template
 * is a gap in what this file knows, not evidence about the template.
 */
export function attributeTemplate(metaTemplateName: string, slug: string): TemplateAttribution {
  const owner = templateOwnerSlug(metaTemplateName);
  if (owner === null) return "unattributed";
  return owner === slug ? "own" : "other-business";
}

/**
 * The sentence shown when a send is refused.
 *
 * Names both businesses. "That template is not yours" sends somebody to read a
 * list of seven near-identical names; saying which company it speaks for ends
 * the question.
 */
export function describeWrongTemplate(metaTemplateName: string, attemptedBySlug: string): string {
  const owner = templateOwnerSlug(metaTemplateName);
  return (
    `"${metaTemplateName}" is ${owner ?? "another business"}'s template, and this broadcast is ` +
    `for ${attemptedBySlug}. Sending it would tell their customers they are hearing from a ` +
    `different company. Templates are shared across the one WhatsApp account, so Meta approving ` +
    `it says nothing about who it is for.`
  );
}
