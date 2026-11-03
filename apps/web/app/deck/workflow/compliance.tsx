import { Fragment, type ReactNode } from "react";
import { REAL_ESTATE_WORKFLOW, type WorkflowAudit } from "@nexus/shared";

/**
 * Dubai compliance (2 Nov 2026, SFS workflow audit): the papers the boss's
 * workflow names, with the step each belongs to — beside what Nexus records
 * about consent, with its counts. Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §6
 *
 * Since the workflow board (3 Nov 2026) the papers are recorded in Nexus: Form
 * A and the Trakheesi permit on each unit, the rest on each deal. The permits
 * are counted as they stand now — units advertised, and how many of those carry
 * a permit that has lapsed. Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §8
 */
const ITEMS: { item: string; step: string; on: "unit" | "deal" }[] = [
  { item: "Form A", step: "S8", on: "unit" },
  { item: "Trakheesi permit", step: "S8", on: "unit" },
  { item: "Ejari", step: "D7", on: "deal" },
  { item: "Form F", step: "D8", on: "deal" },
  { item: "KYC/AML", step: "D8", on: "deal" },
  { item: "DLD transfer", step: "D8", on: "deal" },
];

const stepName = (id: string) => {
  const step = REAL_ESTATE_WORKFLOW.steps.find((s) => s.id === id);
  return step ? `${step.tag} · ${step.name}` : id;
};

function permitsLine(permits: WorkflowAudit["evidence"]["permits"] | undefined): ReactNode {
  const { advertised = 0, expired = 0 } = permits ?? {};
  const lapsed = `${expired.toLocaleString("en-GB")} with an expired permit`;
  return (
    <>
      On the board: {advertised.toLocaleString("en-GB")} {advertised === 1 ? "unit" : "units"} advertised ·{" "}
      {expired > 0 ? <span className="wf-warn">{lapsed}</span> : lapsed}
    </>
  );
}

export function ComplianceTable({ evidence }: { evidence: WorkflowAudit["evidence"] }) {
  const consent = [
    { label: "Opted out of re-engagement", count: evidence.contacts.optedOut },
    { label: "Unsubscribed from campaign emails", count: evidence.contacts.emailOptedOut },
    { label: 'Marked "not a customer"', count: evidence.contacts.notACustomer },
  ];
  return (
    <div className="wf-compliance">
      <div className="kit-table-wrap">
        <table className="kit-table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Step</th>
              <th scope="col">In Nexus</th>
            </tr>
          </thead>
          <tbody>
            {ITEMS.map((row) => (
              <tr key={row.item}>
                <th scope="row">{row.item}</th>
                <td>{stepName(row.step)}</td>
                <td>{row.on === "unit" ? permitsLine(evidence.permits) : "Recorded on each deal on the board"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="wf-consent" aria-label="What Nexus records about consent, in total">
        <h4>What Nexus records about consent, in total</h4>
        <dl className="kit-rows wf-rows">
          {consent.map((c) => (
            <Fragment key={c.label}>
              <dt>{c.label}</dt>
              <dd>{c.count.toLocaleString("en-GB")}</dd>
            </Fragment>
          ))}
        </dl>
      </section>
    </div>
  );
}
