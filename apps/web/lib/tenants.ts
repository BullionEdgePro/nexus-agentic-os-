import type { BusinessSlug } from "@nexus/shared";

/**
 * The five businesses, in one place.
 *
 * This list used to exist three times — once on the public page, once on the
 * deck, once in the inbox switcher — and they drifted. Juris Prime was labelled
 * "UAE Licensing" on two of them long after the real site turned out to be
 * document attestation, and correcting it meant finding every copy. A list
 * describing the same five businesses is one fact, so it is stored once.
 *
 * `status` is what the platform can actually do for that tenant today, not an
 * aspiration:
 *   live       — answering customers on WhatsApp right now
 *   onboarding — indexed, keyworded and governed, waiting on a WhatsApp number
 *   offline    — its website is unreachable, so it has no knowledge base
 *
 * `angle` is the node's position on the switchboard plate, in degrees from
 * twelve o'clock. It lives here because the plate is drawn from this list.
 */
export type TenantStatus = "live" | "onboarding" | "offline";

export interface Tenant {
  slug: BusinessSlug;
  ref: string;
  name: string;
  role: string;
  status: TenantStatus;
  angle: number;
  /** Shown on the plate until real traffic figures arrive. */
  note: string;
}

export const TENANTS: Tenant[] = [
  { slug: "zipicka", ref: "N-01", name: "Zipicka", role: "E-commerce", status: "live", angle: -90, note: "—" },
  { slug: "juris-prime", ref: "N-02", name: "Juris Prime", role: "Attestation & Notary", status: "onboarding", angle: -18, note: "onboarding" },
  { slug: "juris-prime-legal", ref: "N-03", name: "Juris Prime Legal", role: "Law Firm", status: "onboarding", angle: 54, note: "strict tier" },
  { slug: "sfs-international", ref: "N-04", name: "SFS International", role: "Real Estate", status: "onboarding", angle: 126, note: "onboarding" },
  // ABR replaced Atif Ali Production on 2026-08-08 (migration 014). It is the
  // SECOND law firm on the number — see the routing note in that migration for
  // why a vague "I need a lawyer" deliberately asks which firm.
  { slug: "abr", ref: "N-05", name: "ABR Advocates", role: "Litigation & Criminal Defence", status: "onboarding", angle: 198, note: "onboarding" },
];

export const LIVE_TENANT_COUNT = TENANTS.filter((t) => t.status === "live").length;

export function tenantName(slug: string): string {
  return TENANTS.find((tenant) => tenant.slug === slug)?.name ?? slug;
}

/** The switcher options every screen shares. */
export const BUSINESS_OPTIONS: { slug: BusinessSlug; label: string }[] = TENANTS.map((tenant) => ({
  slug: tenant.slug,
  label: tenant.name,
}));
