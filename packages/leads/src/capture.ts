import { getPool } from "@nexus/db";
import { scoreLead, type LeadAssessment } from "./score.js";

/**
 * Capture a lead an employee got on their OWN WhatsApp.
 *
 * The platform runs one WhatsApp Business number for all five businesses, and
 * employees follow up from the phone in their pocket. That is deliberate — a
 * Business API number per person costs money and needs Meta approval — but it
 * meant anything won on a personal phone was invisible here. No lead, no score,
 * no attribution. The pipeline showed only what happened to land on the CRM
 * number, which for a sales team is most of the story missing.
 *
 * Scored by the same rules engine as an inbound message, so a lead is comparable
 * however it arrived. The employee's own words about the enquiry are the input,
 * which is not as good as the customer's own — but a slightly noisier score on
 * a real lead beats an accurate score on a lead nobody recorded.
 */
export interface CaptureLeadInput {
  organizationId: string;
  employeeId: string;
  /** The customer's WhatsApp number, already normalised to digits. */
  contactWaId: string;
  contactName?: string | null;
  /** What the employee says the customer wants. Scored. */
  note: string;
}

export interface CapturedLead extends LeadAssessment {
  contactId: string;
  isNewContact: boolean;
  note: string;
}

export async function captureEmployeeLead(input: CaptureLeadInput): Promise<CapturedLead> {
  const pool = getPool();

  // Reuse `contacts` rather than a separate table, keyed on the same
  // (organization_id, wa_id). If this person later messages the shared number
  // the webhook finds THIS row instead of creating a second one, so the
  // employee's groundwork and the inbound conversation end up on one contact
  // automatically. A parallel table would have needed a merge step that nobody
  // would remember to run.
  const { rows } = await pool.query<{ id: string; inserted: boolean }>(
    `insert into contacts (organization_id, wa_id, display_name, captured_by_employee_id, captured_at)
     values ($1, $2, $3, $4, now())
     on conflict (organization_id, wa_id) do update set
       -- Never overwrite a name we already have with a blank one, and never
       -- re-attribute a contact who was already known: the first employee to
       -- find someone keeps the credit.
       display_name = coalesce(contacts.display_name, excluded.display_name),
       captured_by_employee_id = coalesce(contacts.captured_by_employee_id, excluded.captured_by_employee_id),
       captured_at = coalesce(contacts.captured_at, excluded.captured_at),
       updated_at = now()
     returning id, (xmax = 0) as inserted`,
    [input.organizationId, input.contactWaId, input.contactName?.trim() || null, input.employeeId]
  );

  const contactId = rows[0].id;
  const isNewContact = rows[0].inserted;

  // A contact an employee went out and found is, by definition, further along
  // than a cold inbound "hi" — someone met them. `priorInboundCount` is the
  // returning-contact signal the scorer already understands, so a known contact
  // scores above a brand-new one without inventing a second scale.
  const { rows: priorRows } = await pool.query<{ count: string }>(
    `select count(*)::text as count from lead_assessments where contact_id = $1`,
    [contactId]
  );

  const assessment = scoreLead({
    text: input.note,
    priorInboundCount: Number(priorRows[0]?.count ?? 0),
  });

  await pool.query(
    `insert into lead_assessments
       (organization_id, contact_id, employee_id, source, note, score, priority, category, signals)
     values ($1, $2, $3, 'employee_direct', $4, $5, $6, $7, $8::jsonb)`,
    [
      input.organizationId,
      contactId,
      input.employeeId,
      input.note,
      assessment.score,
      assessment.priority,
      assessment.category,
      JSON.stringify(assessment.signals),
    ]
  );

  // Same standing update as an inbound assessment — highest score ever reached,
  // not the most recent, so a follow-up "thanks" cannot bury a real lead.
  await pool.query(
    `update contacts
        set lead_score = greatest(coalesce(lead_score, 0), $2),
            lead_priority = case
              when coalesce(lead_score, 0) >= $2 then lead_priority
              else $3
            end,
            updated_at = now()
      where id = $1`,
    [contactId, assessment.score, assessment.priority]
  );

  return { ...assessment, contactId, isNewContact, note: input.note };
}

export interface EmployeeLeadRow {
  assessmentId: string;
  contactId: string;
  contactWaId: string;
  contactName: string | null;
  note: string | null;
  score: number;
  priority: string;
  category: string;
  createdAt: string;
  employeeName: string | null;
}

/** Leads an employee brought in from their own phone, newest first. */
export async function listEmployeeLeads(
  organizationId: string,
  employeeId?: string | null,
  limit = 50
): Promise<EmployeeLeadRow[]> {
  const { rows } = await getPool().query<{
    id: string;
    contact_id: string;
    wa_id: string;
    display_name: string | null;
    note: string | null;
    score: number;
    priority: string;
    category: string;
    created_at: string;
    employee_name: string | null;
  }>(
    `select la.id, la.contact_id, c.wa_id, c.display_name, la.note,
            la.score, la.priority, la.category, la.created_at,
            e.full_name as employee_name
       from lead_assessments la
       join contacts c on c.id = la.contact_id
       left join employees e on e.id = la.employee_id
      where la.organization_id = $1
        and la.source = 'employee_direct'
        and ($2::uuid is null or la.employee_id = $2)
      order by la.created_at desc
      limit $3`,
    [organizationId, employeeId ?? null, limit]
  );

  return rows.map((row) => ({
    assessmentId: row.id,
    contactId: row.contact_id,
    contactWaId: row.wa_id,
    contactName: row.display_name,
    note: row.note,
    score: row.score,
    priority: row.priority,
    category: row.category,
    createdAt: row.created_at,
    employeeName: row.employee_name,
  }));
}
