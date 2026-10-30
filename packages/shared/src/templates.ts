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
 * Attribution has three answers, not two — this business's, another business's,
 * and unknown — and of those only the middle one is refused. An unattributed
 * template is NOT hidden as a rule: hiding every unrecognised template would
 * make one created by hand in Meta's console vanish with no explanation, and
 * somebody would reasonably conclude the sync was broken.
 *
 * The one exception is a short, explicit HIDDEN list (below).
 * `klaviyo_double_optin` and `klaviyo_default_helpdesk_template` are Klaviyo's
 * own system templates, left on the shared account by that integration and
 * meant for nobody here to send. The owner asked for them gone (2026-08-30), so
 * they are suppressed BY NAME — not for being unattributed. A hand-made
 * template still shows; only these two, known to belong to another system, do
 * not.
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
    "sfs-international": ["sfs_property_update", "sfs_general_update"],
    "juris-prime": ["juris_prime_attestation_update"],
    "juris-prime-legal": ["juris_prime_legal_update"],
    abr: ["abr_matter_update"],
  });

/**
 * Templates on the shared account that no business here should ever be offered —
 * another system's, suppressed by name at the owner's request. Kept deliberately
 * tiny and explicit: a blocklist of known outsiders, NOT a rule against
 * unrecognised templates (see the note at the top of this file). The sync skips
 * these so they never enter the mirror, and the pickers filter them so any row
 * that predates the skip still never shows.
 */
export const HIDDEN_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  "klaviyo_double_optin",
  "klaviyo_default_helpdesk_template",
]);

export function isHiddenTemplate(metaTemplateName: string): boolean {
  return HIDDEN_TEMPLATE_NAMES.has(metaTemplateName);
}

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
  return SLUG_BY_TEMPLATE[metaTemplateName] ?? bulkTemplateOwnerSlug(metaTemplateName);
}

export type TemplateAttribution = "own" | "other-business" | "unattributed";

/**
 * Whether `slug` may send under `metaTemplateName`.
 *
 * A refusal is a template positively known to belong to someone else. Nothing
 * is refused for being unrecognised, because an unrecognised template is a gap
 * in what this file knows, not evidence about the template — with one
 * exception: a `bulk_` name says an admin wrote it for ONE business, so one
 * whose code nobody here owns is refused everywhere rather than offered to all.
 */
export function attributeTemplate(metaTemplateName: string, slug: string): TemplateAttribution {
  const owner = templateOwnerSlug(metaTemplateName);
  if (owner === null) return isBulkTemplate(metaTemplateName) ? "other-business" : "unattributed";
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

// ============================================================
// A staff member's own templates (28 Oct 2026)
// ============================================================
//
// Staff write their own campaign messages and submit them to Meta from My
// campaigns. Each one is that person's alone: nobody else in the business, and
// no other business on the shared account, is offered it.
//
// THE OWNER IS IN THE NAME, not only in a column. The template sync writes one
// row per business for everything on the shared WhatsApp account, under
// whichever business it is syncing, and knows nothing about who wrote what. A
// column set at creation would exist on one of those rows and be missing from
// the other four. The name is the one thing every copy carries, so
// `staff_<first 8 hex of the employee id>_<label>` makes the owner readable
// from any row, on any account, after any sync.

const STAFF_TEMPLATE_NAME = /^staff_([0-9a-f]{8})_/;

/** The name prefix every template written by this employee carries. */
export function staffTemplatePrefix(employeeId: string): string {
  return `staff_${employeeId.replace(/-/g, "").slice(0, 8).toLowerCase()}_`;
}

/** A typed label as Meta accepts it in a name: lowercase, a-z 0-9 and _. */
function templateWords(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48)
      .replace(/_+$/g, "") || "message"
  );
}

/** Meta's template name for a staff member's label: lowercase, a-z 0-9 and _. */
export function staffTemplateName(employeeId: string, label: string): string {
  return staffTemplatePrefix(employeeId) + templateWords(label);
}

/** Whether a template was written by a staff member at all. */
export function isStaffTemplate(metaTemplateName: string): boolean {
  return STAFF_TEMPLATE_NAME.test(metaTemplateName);
}

/**
 * Whether `employeeId` may see and send this template: any template that is
 * not a staff member's, and their own.
 */
export function staffMayUseTemplate(metaTemplateName: string, employeeId: string): boolean {
  return !isStaffTemplate(metaTemplateName) || metaTemplateName.startsWith(staffTemplatePrefix(employeeId));
}

/** The label a staff member typed, read back out of the name. */
export function staffTemplateLabel(metaTemplateName: string): string {
  return metaTemplateName.replace(STAFF_TEMPLATE_NAME, "").replace(/_/g, " ");
}

// ============================================================
// An admin's own approved messages (30 Oct 2026)
// ============================================================
//
// Admins write new approved messages from Bulk messaging, one business at a
// time. The owner is in the name for the same reason staff templates carry
// theirs: a sync copies every template into every business on the account. A
// short fixed code per business rather than the slug, because people read
// these names and "bulk_juris_prime_legal_" would be half the label.

export const BULK_TEMPLATE_CODE_BY_SLUG: Readonly<Record<string, string>> = Object.freeze({
  zipicka: "zp",
  "sfs-international": "sfs",
  "juris-prime": "jp",
  "juris-prime-legal": "jpl",
  abr: "abr",
});

const SLUG_BY_BULK_CODE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(BULK_TEMPLATE_CODE_BY_SLUG).map(([slug, code]) => [code, slug]))
);

const BULK_TEMPLATE_NAME = /^bulk_([a-z0-9]+)_/;

/** Meta's template name for an admin's label in this business, or null when it has no code. */
export function bulkTemplateName(slug: string, label: string): string | null {
  const code = BULK_TEMPLATE_CODE_BY_SLUG[slug];
  return code ? `bulk_${code}_${templateWords(label)}` : null;
}

/** Whether an admin wrote this template from Bulk messaging. */
export function isBulkTemplate(metaTemplateName: string): boolean {
  return BULK_TEMPLATE_NAME.test(metaTemplateName);
}

/** The label the admin typed, read back out of the name. */
export function bulkTemplateLabel(metaTemplateName: string): string {
  return metaTemplateName.replace(BULK_TEMPLATE_NAME, "").replace(/_/g, " ");
}

/** The business a `bulk_` name was written for; null for any other name or an unknown code. */
function bulkTemplateOwnerSlug(metaTemplateName: string): string | null {
  const code = BULK_TEMPLATE_NAME.exec(metaTemplateName)?.[1];
  return code ? SLUG_BY_BULK_CODE[code] ?? null : null;
}

export const STAFF_TEMPLATE_BODY_MAX = 1024;

/**
 * A staff member's message turned into what Meta accepts, or why not.
 *
 * `{name}` is the one placeholder, filled with the recipient's first name at
 * send time (see staffTemplateParams). Meta refuses a body that starts or ends
 * with a placeholder, and any other `{{…}}` would be a parameter nobody fills.
 * Said in sentences for the form, because Meta's own refusal arrives in English
 * after a wait and names a rule rather than the line.
 */
export function staffTemplateBody(
  text: string
): { body: string; paramCount: number; example: string[] } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { error: "Write the message." };
  if (trimmed.length > STAFF_TEMPLATE_BODY_MAX) {
    return { error: `Keep the message under ${STAFF_TEMPLATE_BODY_MAX} characters.` };
  }
  if (/\{\{|\}\}/.test(trimmed)) return { error: "Use {name} for the client's name — no other placeholders." };
  const names = trimmed.match(/\{name\}/gi) ?? [];
  if (names.length > 1) return { error: "Use {name} once." };
  const stray = trimmed.replace(/\{name\}/gi, "");
  if (/[{}]/.test(stray)) return { error: "Use {name} for the client's name — no other placeholders." };
  if (/^\{name\}/i.test(trimmed) || /\{name\}[\s.!?,]*$/i.test(trimmed)) {
    return { error: "WhatsApp will not approve a message that starts or ends with {name}. Add words before and after it." };
  }
  if (names.length === 0) return { body: trimmed, paramCount: 0, example: [] };
  return { body: trimmed.replace(/\{name\}/i, "{{1}}"), paramCount: 1, example: ["Sara"] };
}
