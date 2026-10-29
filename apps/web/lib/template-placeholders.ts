/**
 * An approved message's blanks as a client will read them (29 Oct 2026): the
 * first is their first name (Nexus fills it with each person's own), any
 * further ones are the "-" Nexus sends.
 */
export function fillPlaceholders(body: string, sampleName: string | null): string {
  const first = sampleName?.trim().split(/\s+/)[0] || "Sara";
  return body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => (n === "1" ? first : "-"));
}
