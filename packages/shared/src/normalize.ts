/**
 * Fold a string to a comparable form.
 *
 * Lives in `shared` rather than in `leads` because three separate layers now
 * compare text and they must agree exactly: lead scoring, switchboard routing,
 * and the onboarding audit that warns when two businesses claim the same
 * keyword. `leads` depends on `db`, so `db` could not import from it — and the
 * onboarding audit quietly grew its own `trim().toLowerCase()` instead.
 *
 * That divergence was a real defect, not a tidiness problem. The audit exists to
 * catch keywords claimed by two businesses; with weaker folding it reported a
 * clean run while the matcher saw a collision, which is worse than having no
 * audit — a clean report is acted on.
 *
 * Pure string work, no dependencies, so anything may import it.
 */
export function normalizeForMatch(value: string): string {
  return (
    value
      .toLowerCase()
      // Tashkeel (harakat) and the superscript alef — decorative, not semantic.
      .replace(/[\u064B-\u0652\u0670]/g, "")
      // Tatweel: a kashida stretching character with no meaning.
      .replace(/\u0640/g, "")
      // Alef with any hamza/madda → bare alef.
      .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
      // Alef maqsura → yaa; these are freely interchanged in practice.
      .replace(/\u0649/g, "\u064A")
      // Taa marbuta → haa; likewise.
      .replace(/\u0629/g, "\u0647")
      // Hamza carriers → their base letters.
      .replace(/\u0624/g, "\u0648")
      .replace(/\u0626/g, "\u064A")
      // Arabic-Indic digits → ASCII, so numbers compare consistently.
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/\s+/g, " ")
      .trim()
  );
}
