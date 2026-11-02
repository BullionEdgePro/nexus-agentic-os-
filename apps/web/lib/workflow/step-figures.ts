import type { WorkflowAudit } from "@nexus/shared";

/**
 * What each workflow step shows for the period (2 Nov 2026, SFS workflow
 * audit): every figure for its window, the first three on its card. A step
 * Nexus does not track shows none — the card says what tracking it would need
 * instead. Pure. Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §4.2
 */
export type StepFigure = { label: string; value: string };

const CHANNEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  sms: "SMS",
  instagram: "Instagram",
  phone: "Phone",
  facebook: "Facebook",
};

/** A channel as people say it ("WhatsApp"); an unknown one as stored. */
export const channelName = (channel: string) => CHANNEL[channel] ?? channel;

const n = (value: number) => value.toLocaleString("en-GB");
const fig = (label: string, value: number): StepFigure => ({ label, value: n(value) });

export function stepFigures(stepId: string, evidence: WorkflowAudit["evidence"]): StepFigure[] {
  const e = evidence;
  const queue = [
    fig("Sent", e.reengagement.sent),
    fig("Replied", e.reengagement.replied),
    fig("Opted out", e.reengagement.optedOut),
    fig("In cooldown now", e.reengagement.inCooldown),
  ];
  switch (stepId) {
    case "S1":
      return [fig("Contacts in total", e.contacts.total), fig("Added", e.contacts.added), fig("With a lead source, in total", e.contacts.withSource)];
    case "S2":
      return [
        fig("Scored", e.qualifier.scored),
        fig("Opted out, in total", e.contacts.optedOut),
        fig("Not a customer, in total", e.contacts.notACustomer),
      ];
    case "S3": {
      const c = e.calls;
      return [
        fig("Messages sent", e.outreach.sent),
        fig("Delivered", e.outreach.delivered),
        fig("Calls logged", c.answered + c.noAnswer + c.voicemail + c.busy + c.failed),
        fig("Messages failed", e.outreach.failed),
        fig("Calls answered", c.answered),
        fig("No answer", c.noAnswer),
        fig("Voicemail", c.voicemail),
        fig("Busy", c.busy),
        fig("Calls failed", c.failed),
      ];
    }
    case "S4":
    case "D3":
      return queue;
    case "D1":
      return [
        fig("New leads", e.leads.total),
        ...Object.entries(e.leads.byChannel)
          .sort((a, b) => b[1] - a[1])
          .map(([channel, count]) => fig(`By ${channelName(channel)}`, count)),
        ...e.leads.bySource.map(({ source, count }) => fig(`From ${source}`, count)),
      ];
    case "D2":
      return [fig("Scored", e.qualifier.scored), fig("Hot", e.qualifier.hot), fig("Sales pitches filtered out", e.leads.pitches)];
    case "D5":
      return [
        fig("Booked", e.viewings.booked),
        fig("Held", e.viewings.held),
        fig("No-show", e.viewings.noShow),
        fig("Cancelled", e.viewings.cancelled),
      ];
    case "D9":
      return [
        fig("Follow-ups created", e.followUps.created),
        fig("Done", e.followUps.done),
        fig("Open now", e.followUps.openNow),
        fig("Overdue now", e.followUps.overdueNow),
      ];
    default:
      return [];
  }
}
