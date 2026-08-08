import { getPool } from "./client.js";
import type { Employee, PresenceSource, PresenceStatus, WeeklySchedule } from "@nexus/shared";

interface EmployeeRow {
  id: string;
  organization_id: string;
  employee_code: string;
  full_name: string;
  email: string | null;
  avatar_url: string | null;
  job_title: string | null;
  department: string | null;
  permissions: Record<string, unknown>;
  whatsapp_phone_number_id: string | null;
  whatsapp_number: string | null;
  timezone: string;
  working_hours: WeeklySchedule;
  break_schedule: WeeklySchedule;
  languages: string[];
  skills: string[];
  expertise: string[];
  twin_enabled: boolean;
  ai_personality: string | null;
  response_style: string | null;
  knowledge_collection: string | null;
  escalation_rules: Record<string, unknown>;
  twin_disclosure: string | null;
  digital_signature: string | null;
  manual_presence: PresenceStatus | null;
  manual_presence_until: string | null;
  last_seen_at: string | null;
  human_first: boolean;
  is_active: boolean;
}

const EMPLOYEE_COLUMNS = `
  id, organization_id, employee_code, full_name, email, avatar_url, job_title, department,
  permissions, whatsapp_phone_number_id, whatsapp_number, timezone, working_hours, break_schedule,
  languages, skills, expertise, twin_enabled, ai_personality, response_style, knowledge_collection,
  escalation_rules, twin_disclosure, digital_signature, manual_presence, manual_presence_until,
  last_seen_at, human_first, is_active
`;

function toEmployee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    organizationId: row.organization_id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    jobTitle: row.job_title,
    department: row.department,
    permissions: row.permissions ?? {},
    whatsappPhoneNumberId: row.whatsapp_phone_number_id,
    whatsappNumber: row.whatsapp_number,
    timezone: row.timezone,
    workingHours: row.working_hours ?? {},
    breakSchedule: row.break_schedule ?? {},
    languages: row.languages ?? [],
    skills: row.skills ?? [],
    expertise: row.expertise ?? [],
    twinEnabled: row.twin_enabled,
    aiPersonality: row.ai_personality,
    responseStyle: row.response_style,
    knowledgeCollection: row.knowledge_collection,
    escalationRules: row.escalation_rules ?? {},
    twinDisclosure: row.twin_disclosure,
    digitalSignature: row.digital_signature,
    manualPresence: row.manual_presence,
    manualPresenceUntil: row.manual_presence_until,
    lastSeenAt: row.last_seen_at,
    humanFirst: row.human_first,
    isActive: row.is_active,
  };
}

export async function listEmployees(organizationId: string): Promise<Employee[]> {
  const { rows } = await getPool().query<EmployeeRow>(
    `select ${EMPLOYEE_COLUMNS} from employees
     where organization_id = $1 and is_active = true
     order by full_name asc`,
    [organizationId]
  );
  return rows.map(toEmployee);
}

export async function findEmployeeById(id: string): Promise<Employee | null> {
  const { rows } = await getPool().query<EmployeeRow>(
    `select ${EMPLOYEE_COLUMNS} from employees where id = $1`,
    [id]
  );
  return rows[0] ? toEmployee(rows[0]) : null;
}

/**
 * The employee who owns this conversation, if one has been assigned.
 *
 * Returns null for every conversation created before the Employee Agent Layer
 * existed (employee_id is null), which is what keeps the reply pipeline's
 * behaviour identical for tenants that have not onboarded employees yet.
 */
export async function findEmployeeForConversation(conversationId: string): Promise<Employee | null> {
  const { rows } = await getPool().query<EmployeeRow>(
    `select ${EMPLOYEE_COLUMNS.split(",").map((c) => `e.${c.trim()}`).join(", ")}
     from conversations c
     join employees e on e.id = c.employee_id
     where c.id = $1`,
    [conversationId]
  );
  return rows[0] ? toEmployee(rows[0]) : null;
}

export async function assignConversationToEmployee(
  conversationId: string,
  employeeId: string | null
): Promise<void> {
  await getPool().query(`update conversations set employee_id = $2 where id = $1`, [
    conversationId,
    employeeId,
  ]);
}

export interface CreateEmployeeInput {
  organizationId: string;
  employeeCode: string;
  fullName: string;
  email?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  /** The employee's own WhatsApp, used for direct customer contact. */
  whatsappNumber?: string | null;
  timezone?: string;
  languages?: string[];
  skills?: string[];
  twinEnabled?: boolean;
  aiPersonality?: string | null;
  responseStyle?: string | null;
  humanFirst?: boolean;
}

/**
 * Add an employee to a business.
 *
 * Upserts on `(organization_id, employee_code)` — the natural key the schema
 * already enforces — so re-submitting the same person updates their profile
 * rather than failing on a constraint. Onboarding a team is exactly the kind of
 * task someone does twice by accident, and a duplicate-key error at that moment
 * is indistinguishable from "the save didn't work".
 *
 * `digital_signature` is deliberately not settable here. It is a human-only
 * attestation the AI twin must never reproduce (see packages/employees/twin.ts),
 * so it does not belong in the same form as job title and skills.
 */
export async function createEmployee(input: CreateEmployeeInput): Promise<Employee> {
  const { rows } = await getPool().query<EmployeeRow>(
    `insert into employees (
       organization_id, employee_code, full_name, email, job_title, department,
       whatsapp_number, timezone, languages, skills, twin_enabled,
       ai_personality, response_style, human_first
     ) values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'Asia/Dubai'),$9,$10,coalesce($11,true),$12,$13,coalesce($14,false))
     on conflict (organization_id, employee_code) do update set
       full_name      = excluded.full_name,
       email          = excluded.email,
       job_title      = excluded.job_title,
       department     = excluded.department,
       whatsapp_number = excluded.whatsapp_number,
       timezone       = excluded.timezone,
       languages      = excluded.languages,
       skills         = excluded.skills,
       twin_enabled   = excluded.twin_enabled,
       ai_personality = excluded.ai_personality,
       response_style = excluded.response_style,
       human_first    = excluded.human_first,
       is_active      = true,
       updated_at     = now()
     returning ${EMPLOYEE_COLUMNS}`,
    [
      input.organizationId,
      input.employeeCode,
      input.fullName,
      input.email ?? null,
      input.jobTitle ?? null,
      input.department ?? null,
      input.whatsappNumber ?? null,
      input.timezone ?? null,
      input.languages ?? [],
      input.skills ?? [],
      input.twinEnabled ?? null,
      input.aiPersonality ?? null,
      input.responseStyle ?? null,
      input.humanFirst ?? null,
    ]
  );
  return toEmployee(rows[0]);
}

/**
 * Take an employee off the rota without deleting them.
 *
 * Their conversations, messages and presence history stay attributed — deleting
 * the row would orphan every message they ever handled. `resolveAssignedEmployee`
 * already treats an inactive employee as no employee, so their conversations
 * fall back to the organization agent rather than going quiet.
 */
export async function deactivateEmployee(employeeId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `update employees set is_active = false, updated_at = now() where id = $1 and is_active = true`,
    [employeeId]
  );
  return (rowCount ?? 0) > 0;
}

export interface AssignedConversation {
  conversationId: string;
  contactId: string;
  contactWaId: string;
  contactName: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  isHumanHandoff: boolean;
  businessName: string;
  businessSlug: string;
}

/**
 * The conversations one employee is responsible for.
 *
 * Reads the business from `routed_organization_id` where the switchboard set
 * one, falling back to the conversation's owning organization. On a shared
 * number those differ: every conversation is owned by the number's owner, so
 * using `organization_id` here would label every customer as Zipicka's
 * regardless of which business the enquiry was actually routed to.
 */
export async function listConversationsForEmployee(
  employeeId: string
): Promise<AssignedConversation[]> {
  const { rows } = await getPool().query<{
    conversation_id: string;
    contact_id: string;
    wa_id: string;
    contact_name: string | null;
    last_message_preview: string | null;
    last_message_at: string | null;
    is_human_handoff: boolean;
    business_name: string;
    business_slug: string;
  }>(
    `select c.id              as conversation_id,
            ct.id             as contact_id,
            ct.wa_id,
            ct.display_name   as contact_name,
            lm.body           as last_message_preview,
            lm.created_at     as last_message_at,
            c.is_human_handoff,
            o.name            as business_name,
            o.slug            as business_slug
       from conversations c
       join contacts ct on ct.id = c.contact_id
       join organizations o on o.id = coalesce(c.routed_organization_id, c.organization_id)
       left join lateral (
         select body, created_at from messages
         where conversation_id = c.id
         order by created_at desc
         limit 1
       ) lm on true
      where c.employee_id = $1
      order by coalesce(lm.created_at, c.opened_at) desc
      limit 100`,
    [employeeId]
  );

  return rows.map((row) => ({
    conversationId: row.conversation_id,
    contactId: row.contact_id,
    contactWaId: row.wa_id,
    contactName: row.contact_name,
    lastMessagePreview: row.last_message_preview,
    lastMessageAt: row.last_message_at,
    isHumanHandoff: row.is_human_handoff,
    businessName: row.business_name,
    businessSlug: row.business_slug,
  }));
}

/** Append-only presence history — never updated, only inserted. */
export async function recordPresenceEvent(input: {
  organizationId: string;
  employeeId: string;
  status: PresenceStatus;
  source: PresenceSource;
}): Promise<void> {
  await getPool().query(
    `insert into employee_presence_events (organization_id, employee_id, status, source)
     values ($1, $2, $3, $4)`,
    [input.organizationId, input.employeeId, input.status, input.source]
  );
}

export async function setManualPresence(input: {
  employeeId: string;
  status: PresenceStatus | null;
  until?: string | null;
}): Promise<void> {
  await getPool().query(
    `update employees
     set manual_presence = $2, manual_presence_until = $3, last_seen_at = now()
     where id = $1`,
    [input.employeeId, input.status, input.until ?? null]
  );
}

export async function touchLastSeen(employeeId: string): Promise<void> {
  await getPool().query(`update employees set last_seen_at = now() where id = $1`, [employeeId]);
}

export async function recordTwinHandback(input: {
  organizationId: string;
  conversationId: string;
  employeeId: string;
  summary: string;
  messagesCovered: number;
  heldFrom?: string | null;
  heldUntil?: string | null;
}): Promise<void> {
  await getPool().query(
    `insert into twin_handbacks
       (organization_id, conversation_id, employee_id, summary, messages_covered, held_from, held_until)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.organizationId,
      input.conversationId,
      input.employeeId,
      input.summary,
      input.messagesCovered,
      input.heldFrom ?? null,
      input.heldUntil ?? null,
    ]
  );
}
