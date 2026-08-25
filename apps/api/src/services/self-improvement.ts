/**
 * The platform switching its own procedures on, and saying so every time.
 *
 * ============================================================
 * WHAT THIS IS
 * ============================================================
 *
 * F14's last piece. `autoActivationDecision` holds the judgement — five rules,
 * each proved in `the-platform-may-switch-a-procedure-on` against a procedure
 * that breaks it. This is the part that reads the drafts, applies that
 * judgement, and makes the result impossible to miss.
 *
 * It runs after the nightly procedure inference, on the same schedule and in the
 * same worker, because acting on evidence the moment it is written is the whole
 * point and a second timer would only add a window where the two disagree.
 *
 * ============================================================
 * RULE 5: NEVER SILENT
 * ============================================================
 *
 * Every activation raises an operator finding, on the business it affects,
 * naming the situation and quoting the evidence that qualified it. That is not
 * decoration — it is the difference between a platform that improves itself and
 * one that changes what it tells customers without anybody knowing.
 *
 * The finding is `info`, not `warn`. Nothing is wrong: this is the feature
 * working. But it appears in the same list the business already reads, carries
 * the same dismissal, and points at the screen where they can switch it off.
 *
 * ============================================================
 * WHAT IT DOES NOT DO
 * ============================================================
 *
 * It never deactivates. Turning a live procedure OFF because a rate moved is a
 * far larger claim than turning a well-evidenced one on, and the reversal is
 * not symmetric: an activation that turns out wrong is one click away from
 * being undone by a person, and a deactivation nobody noticed leaves an agent
 * quietly worse with no trace of why.
 *
 * It also never edits steps. `proposed_steps` exists precisely so a newer
 * inference lands somewhere a human can accept it, and an active procedure's
 * steps are frozen against the writer. That stays true.
 */
import {
  autoActivationCandidates,
  listProcedures,
  setProcedureActive,
  withTenant,
  AUTO_REVIEWER,
  type ProcedureRecord,
} from "@nexus/db";
import { logger } from "../lib/logger.js";

export interface AutoActivation {
  organizationId: string;
  procedureId: string;
  intentCategory: string;
  language: string;
  derivedFromCount: number;
  reason: string;
}

/**
 * Consider one business's drafts and switch on those that qualify.
 *
 * Returns what it did, so the caller can raise the findings. Deliberately does
 * NOT raise them itself: this module decides and acts, the operator layer
 * announces, and keeping those apart is what lets the announcement be tested
 * without a database.
 */
export async function activateWellEvidencedProcedures(
  organizationId: string
): Promise<AutoActivation[]> {
  const procedures: ProcedureRecord[] = await withTenant(organizationId, () =>
    listProcedures(organizationId)
  );

  const candidates = autoActivationCandidates(procedures);
  if (candidates.length === 0) return [];

  const done: AutoActivation[] = [];

  for (const { procedure, reason } of candidates) {
    try {
      const updated = await withTenant(organizationId, () =>
        setProcedureActive(organizationId, procedure.id, true, AUTO_REVIEWER)
      );

      // Null means the row did not change — somebody activated or removed it
      // between the read and the write. Not an error, and not something to
      // announce: nothing happened.
      if (!updated) continue;

      done.push({
        organizationId,
        procedureId: procedure.id,
        intentCategory: procedure.intentCategory,
        language: procedure.language,
        derivedFromCount: procedure.derivedFromCount,
        reason,
      });

      logger.info(
        {
          organizationId,
          procedureId: procedure.id,
          intent: procedure.intentCategory,
          derivedFromCount: procedure.derivedFromCount,
        },
        "Switched on a procedure this platform inferred — nobody approved it, and the business is being told"
      );
    } catch (err) {
      // The unique index is the likeliest cause: another procedure for this
      // situation went active since the read. Logged rather than thrown,
      // because one business's collision must not stop the sweep for the other
      // four, and the next run will reconsider it with fresh evidence.
      logger.warn(
        { err, organizationId, procedureId: procedure.id },
        "Could not switch on an inferred procedure — leaving it for a person"
      );
    }
  }

  return done;
}
