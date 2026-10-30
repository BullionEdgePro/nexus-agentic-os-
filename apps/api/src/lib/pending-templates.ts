import type { TemplateRow } from "@nexus/db";
import { attributeTemplate, bulkTemplateLabel, isBulkTemplate } from "@nexus/shared";
import type { TemplateReview } from "./whatsapp-client.js";

/**
 * An admin's new approved messages that WhatsApp has not approved yet
 * (30 Oct 2026): what Bulk messaging lists under "Waiting for WhatsApp".
 */
export interface PendingMessage {
  id: string;
  name: string;
  label: string;
  language: string;
  status: string;
  /** WhatsApp's reason in a sentence, once a check has read it; null otherwise. */
  reason: string | null;
  createdAt: string;
}

const REASONS: Record<string, string> = {
  INVALID_FORMAT: "WhatsApp found a formatting problem, often a placeholder in the wrong place.",
  PROMOTIONAL: "WhatsApp read it as too promotional for its rules. Make it plainer and drop urgent sales language.",
  INCORRECT_CATEGORY: "WhatsApp thinks it does not belong in the marketing category.",
  TAG_CONTENT_MISMATCH: "WhatsApp thinks the wording does not match the category it was sent under.",
  ABUSIVE_CONTENT: "WhatsApp flagged the wording as abusive or threatening.",
  SCAM: "WhatsApp flagged it as possibly misleading. Remove anything that reads as too good to be true.",
};

/** Meta's rejection code as a sentence for the person who wrote the message. */
export function explainRejection(reason: string | null): string {
  if (!reason) return "WhatsApp did not give a reason.";
  return REASONS[reason] ?? `WhatsApp gave the reason: ${reason}.`;
}

/**
 * This business's own `bulk_` messages on one account that are not approved,
 * newest first, at most ten. A review from WhatsApp, when given, supplies the
 * current status and the reason; from the mirror alone the reason stays null.
 */
export function pendingFrom(
  // `createdAt` is typed string on TemplateRow, but node-postgres returns
  // timestamptz as a Date — so it is read through new Date() either way.
  rows: Array<Pick<TemplateRow, "id" | "metaTemplateName" | "language" | "status" | "isApproved"> & { createdAt: string | Date }>,
  slug: string,
  reviews: TemplateReview[] = []
): PendingMessage[] {
  return rows
    .filter(
      (row) =>
        !row.isApproved && isBulkTemplate(row.metaTemplateName) && attributeTemplate(row.metaTemplateName, slug) === "own"
    )
    .map((row) => {
      const review = reviews.find((r) => r.name === row.metaTemplateName && r.language === row.language);
      const status = review?.status ?? row.status ?? "PENDING";
      return {
        id: row.id,
        name: row.metaTemplateName,
        label: bulkTemplateLabel(row.metaTemplateName),
        language: row.language,
        status,
        reason: status === "REJECTED" && review ? explainRejection(review.rejectedReason) : null,
        createdAt: new Date(row.createdAt).toISOString(),
      };
    })
    // An approved review that the mirror has not caught up with is not waiting.
    .filter((pending) => pending.status !== "APPROVED")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 10);
}
