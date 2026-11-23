import type { BayutAnswer } from "./bayut.js";

/**
 * The Bayut token check's words (24 Nov 2026), shared by Portal settings' Save
 * and check / Check again and by the sync, which checks a token again by itself
 * when the last check could not reach Bayut (final review I6). A check is good
 * only when Bayut names the agency the token belongs to: the first without a
 * parent, else the first. Its words are the ones the board reads: "Could not
 * reach Bayut: …" is check-failed, anything else a refused token. The token is
 * blanked out of Bayut's words, even if Bayut echoes it.
 *
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §4, §10, §12, §14
 */

export type BayutCheck = { checkError: string | null; agencyId: number | null; agencyName: string | null };

export const BAYUT_NO_AGENCY = "Bayut answered without an agency";

/** Where the Bayut users a good check read are kept, for the agent links. */
export const bayutUsersKey = (organizationId: string) => `bayut-users:${organizationId}`;

const blanked = (message: string, token: string) => (token ? message.split(token).join("•••") : message);

/** What Bayut's answer to `GET /agencies` says of the token. */
export function bayutCheckOf(answer: BayutAnswer<{ id: number; parentId: number | null; name: string }[]>, token: string): BayutCheck {
  if (!answer.ok) {
    const message = blanked(answer.message, token);
    const checkError =
      answer.kind === "token-refused" || answer.kind === "refused" ? `Bayut refused the token: ${message}` : `Could not reach Bayut: ${message}`;
    return { checkError, agencyId: null, agencyName: null };
  }
  const agency = answer.data.find((a) => a.parentId === null) ?? answer.data[0];
  if (!agency) return { checkError: BAYUT_NO_AGENCY, agencyId: null, agencyName: null };
  return { checkError: null, agencyId: agency.id, agencyName: agency.name || null };
}
