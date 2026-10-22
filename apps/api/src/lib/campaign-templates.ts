import { OPT_OUT_BUTTON_LABEL } from "@nexus/agents";
import type { TemplateSpec } from "./whatsapp-client.js";

/**
 * The messages each business may start a WhatsApp conversation with.
 *
 * ONE CATALOGUE, TWO READERS (22 Oct 2026). `scripts/provision-templates.ts`
 * submits these to the company account by hand; the staff template sync
 * (`services/template-sync.ts`) submits whatever is missing to every staff
 * member's OWN account, with that number's token, so a newly connected number
 * gets its business's messages without anybody running a script. Keshav
 * Arora's SFS number landed on an empty account on 22 Oct and could not send a
 * campaign until this existed.
 *
 * Why one each, when all five share a WhatsApp number: the customer sees the
 * sender as the same number either way, so the message text is the only thing
 * telling them who is writing. A generic "we have an update for you" from a
 * number that also handles four unrelated businesses is exactly the kind of
 * message people report as spam — and reports are what get a WhatsApp number
 * restricted. Naming the business in the body is a deliverability decision as
 * much as a branding one.
 *
 * THE FIRST FIVE are UTILITY rather than MARKETING. Utility templates describe an
 * existing relationship — a request the customer made, a matter already open —
 * and Meta approves them readily and prices them lower. A marketing template
 * needs explicit opt-in and, on an account still completing verification, is
 * the likelier rejection. These say "there is an update on the thing you asked
 * us about", which is what a business CRM actually sends.
 *
 * Each body carries one placeholder, the customer's name. Meta requires an
 * example value for every placeholder or the submission is rejected outright.
 *
 * THE SIXTH IS MARKETING, and is the exception the paragraph above describes.
 * It exists because staff campaigns had nothing worth sending: the only
 * templates a Zipicka staff member could pick were an order update and two
 * generic Klaviyo ones. It carries a "Stop promotions" quick-reply button, and
 * that button is not decoration — `contacts.reengagement_opted_out` had NO
 * WRITER until this was built, so every customer on the platform had been
 * unable to opt out since the column was created in migration 035. A marketing
 * message nobody can stop is what produces a spam report, and the quality
 * rating a spam report damages belongs to one number that six businesses share.
 *
 * Its wording claims nothing that could stop being true. The store's own site
 * advertises 20% off and free delivery; neither is in here, because a template
 * is approved once and sent for months, and the discount in particular is the
 * claim a previous piece of work was blocked on for not actually existing.
 */
export const CAMPAIGN_TEMPLATES: Record<string, TemplateSpec[]> = {
  zipicka: [
    {
      name: "zipicka_order_update",
      language: "en",
      category: "UTILITY",
      body:
        "Hello {{1}}, this is Zipicka. There is an update on your order with us. " +
        "Reply to this message and our team will help you right away.",
      example: ["Ahmed"],
    },
    {
      name: "zipicka_promotions",
      language: "en",
      category: "MARKETING",
      body:
        "Hello {{1}}, this is Zipicka. We stock beauty, pet care, home essentials and " +
        "electronics with delivery across the UAE. Reply to this message to see what is " +
        "available or to ask us anything. If you would rather not hear from us, tap Stop " +
        "promotions below.",
      example: ["Ahmed"],
      buttons: [OPT_OUT_BUTTON_LABEL],
    },
  ],
  "sfs-international": [
    {
      name: "sfs_property_update",
      language: "en",
      category: "UTILITY",
      body:
        "Hello {{1}}, this is SFS International Real Estate. There is an update on the " +
        "property enquiry you made with us. Reply to this message and our team will assist you.",
      example: ["Ahmed"],
    },
    {
      name: "sfs_general_update",
      language: "en",
      category: "UTILITY",
      body:
        "Hello {{1}}, this is SFS International Real Estate. We have news on properties that " +
        "may interest you. Reply to this message and our team will assist you.",
      example: ["Ahmed"],
    },
  ],
  "juris-prime": [
    {
      name: "juris_prime_attestation_update",
      language: "en",
      category: "UTILITY",
      body:
        "Hello {{1}}, this is Juris Prime. There is an update on your document attestation " +
        "request. Reply to this message and our team will assist you.",
      example: ["Ahmed"],
    },
  ],
  "juris-prime-legal": [
    {
      name: "juris_prime_legal_update",
      language: "en",
      category: "UTILITY",
      body:
        "Hello {{1}}, this is Juris Prime Legal. There is an update on the legal service " +
        "you requested from us. Reply to this message and our team will assist you.",
      example: ["Ahmed"],
    },
  ],
  abr: [
    {
      name: "abr_matter_update",
      language: "en",
      category: "UTILITY",
      body:
        "Hello {{1}}, this is ABR Advocates and Legal Consultants. There is an update on " +
        "the matter you raised with our office. Reply to this message and our team will assist you.",
      example: ["Ahmed"],
    },
  ],
};

/**
 * The catalogue messages an account does not hold yet, by name.
 *
 * `presentNames` is every name Meta lists for the account, in ANY status. A
 * REJECTED template counts as present on purpose: resubmitting it every half
 * hour would only collect the same rejection, and the fix for a rejection is a
 * changed message, made here by a person.
 */
export function missingCampaignTemplates(slug: string, presentNames: string[]): TemplateSpec[] {
  const present = new Set(presentNames);
  return (CAMPAIGN_TEMPLATES[slug] ?? []).filter((spec) => !present.has(spec.name));
}
