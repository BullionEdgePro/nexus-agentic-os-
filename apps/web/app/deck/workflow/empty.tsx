/**
 * A business whose owner has drawn no workflow (2 Nov 2026, SFS workflow
 * audit): said plainly, never an error and never an empty drawing.
 * Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §9
 */
export function NoWorkflow() {
  return (
    <div className="act-empty">
      <strong>No workflow is set up for this business yet.</strong>
      <br />
      The audit checks a workflow the business&rsquo;s owner has drawn against what Nexus recorded, and
      this business has none drawn.
    </div>
  );
}
