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
