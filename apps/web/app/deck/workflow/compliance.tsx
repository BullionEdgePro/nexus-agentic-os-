import { Fragment } from "react";
import { REAL_ESTATE_WORKFLOW, type WorkflowAudit } from "@nexus/shared";

/**
 * Dubai compliance (2 Nov 2026, SFS workflow audit): the papers the boss's
 * workflow names, each kept outside Nexus today, with the step it belongs to
 * and what tracking it would need — beside what Nexus does record about
 * consent, with its counts. Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §6
 */
const ITEMS: { item: string; step: string; needs: string }[] = [
  { item: "Form A", step: "S8", needs: "The signed Form A per listing." },
  { item: "Trakheesi permit", step: "S8", needs: "The permit number and expiry per listing." },
  { item: "Ejari", step: "D7", needs: "The Ejari number per rent deal." },
  { item: "Form F", step: "D8", needs: "The signed Form F per sale deal." },
  { item: "KYC/AML", step: "D8", needs: "The KYC/AML check per buyer and seller." },
  { item: "DLD transfer", step: "D8", needs: "The DLD transfer per sale deal." },
];

const stepName = (id: string) => {
  const step = REAL_ESTATE_WORKFLOW.steps.find((s) => s.id === id);
  return step ? `${step.tag} · ${step.name}` : id;
};

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
              <th scope="col">Tracking it would need</th>
            </tr>
          </thead>
          <tbody>
            {ITEMS.map((row) => (
              <tr key={row.item}>
                <th scope="row">{row.item}</th>
                <td>{stepName(row.step)}</td>
                <td>Kept outside Nexus</td>
                <td>{row.needs}</td>
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
