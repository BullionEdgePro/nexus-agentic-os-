import { getPool, withAllTenants, withTenant } from "./client.js";
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

/**
 * Is there anybody who could actually take a conversation over?
 *
 * Asked on the escalation path, and it is the question that path never asked.
 * Escalating tells the customer a specialist is coming AND pauses the AI — two
 * commitments that only make sense if someone exists to honour them. With no
 * active employee, that combination is the worst outcome available: the
 * customer is promised help and then silenced, and nothing anywhere records a
 * failure. One such conversation sat open for eleven days before an operator
 * noticed the absence.
 *
 * Counted rather than listed: the caller only needs to know whether the rota is
 * empty, and fetching every employee's full profile to answer a yes/no on the
 * reply path is work nobody uses.
 */
export async function hasActiveEmployees(organizationId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ n: string }>(
    `select count(*)::text as n from employees
      where organization_id = $1 and is_active = true`,
    [organizationId]
  );
  return Number(rows[0]?.n ?? 0) > 0;
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
 * Fields that are not supplied are LEFT ALONE. The first version overwrote them
 * with null, so saving a corrected name quietly erased the person's email, job
 * title and WhatsApp number — and with the email went the address they sign in
 * with, while their access code stayed valid and unusable. Every unit test
 * passed; a live self-check found it.
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
     ) values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'Asia/Dubai'),
               coalesce($9::text[],'{}'),coalesce($10::text[],'{}'),
               coalesce($11,true),$12,$13,coalesce($14,false))
     -- An omitted field KEEPS its stored value. Writing email = excluded.email
     -- here meant re-submitting a partial form erased everything it did not
     -- mention: a live self-check saved someone with just a corrected name and
     -- silently wiped their email, job title and WhatsApp number — taking with
     -- it the address they sign in with, while leaving their access code valid
     -- and unusable. Nothing errored.
     --
     -- The parameters are read directly rather than through excluded, because
     -- excluded holds the INSERT row, where the coalesces above have already
     -- turned "not provided" into a default and lost the distinction.
     --
     -- Consequence worth stating: this endpoint cannot clear a field. That is
     -- the right trade for a form people re-submit — losing data by omission is
     -- far worse than needing an explicit edit to blank something.
     on conflict (organization_id, employee_code) do update set
       full_name      = excluded.full_name,
       email          = coalesce($4, employees.email),
       job_title      = coalesce($5, employees.job_title),
       department     = coalesce($6, employees.department),
       whatsapp_number = coalesce($7, employees.whatsapp_number),
       timezone       = coalesce($8, employees.timezone),
       languages      = coalesce($9, employees.languages),
       skills         = coalesce($10, employees.skills),
       twin_enabled   = coalesce($11, employees.twin_enabled),
       ai_personality = coalesce($12, employees.ai_personality),
       response_style = coalesce($13, employees.response_style),
       human_first    = coalesce($14, employees.human_first),
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
      // null, not [] — an empty array is a real value meaning "clear the list",
      // and passing it for an omitted field would wipe the stored one.
      input.languages ?? null,
      input.skills ?? null,
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

/**
 * Set an employee's working hours and breaks.
 *
 * THERE WAS NO WRITER FOR THESE COLUMNS AT ALL until 2026-08-14, and the gap was
 * invisible because nothing errored: `createEmployee` does not take a rota, so
 * every employee ever created through the product arrived with `working_hours =
 * '{}'`. `isScheduledThroughout` and `hasStaffOnShift` both treat an empty rota
 * as NOT available — deliberately, because promising a person nobody has said is
 * working is the failure those functions exist to prevent. The consequence was
 * that the entire employee layer was, in production, permanently off-shift.
 *
 * It surfaced only when appointments shipped and the diary could offer nothing:
 * an agent politely declining to book, forever, with every container green. The
 * bookings self-check had to set a probe rota with raw SQL because this function
 * did not exist, which was the tell.
 *
 * Validation belongs to `parseWeeklySchedule` in @nexus/employees, at the route,
 * so a bad rota is rejected with the day and window named rather than stored as
 * jsonb that reads back as "never working". This function takes an already
 * validated schedule and does not re-check it — one validator, at the edge.
 */
export async function updateEmployeeSchedule(
  employeeId: string,
  input: { workingHours?: WeeklySchedule; breakSchedule?: WeeklySchedule; timezone?: string }
): Promise<Employee | null> {
  const { rows } = await getPool().query<EmployeeRow>(
    `update employees
        set working_hours  = coalesce($2::jsonb, working_hours),
            break_schedule = coalesce($3::jsonb, break_schedule),
            -- Timezone travels with the rota because it is meaningless without
            -- one: "09:00–17:00" is not a fact until you know whose morning.
            timezone       = coalesce($4, timezone),
            updated_at     = now()
      where id = $1
      returning *`,
    [
      employeeId,
      input.workingHours ? JSON.stringify(input.workingHours) : null,
      input.breakSchedule ? JSON.stringify(input.breakSchedule) : null,
      input.timezone ?? null,
    ]
  );
  return rows[0] ? toEmployee(rows[0]) : null;
}

/**
 * Store a freshly issued access code hash, replacing any previous one.
 *
 * Reissuing is the whole recovery story: there is no reset flow because there
 * is nothing to reset to — the operator generates a new code and hands it over,
 * which immediately invalidates the old one.
 */
export async function setEmployeeAccessCodeHash(
  employeeId: string,
  hash: string
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `update employees
        set access_code_hash = $2, access_code_set_at = now(), updated_at = now()
      where id = $1 and is_active = true`,
    [employeeId, hash]
  );
  return (rowCount ?? 0) > 0;
}

export interface EmployeeLoginCandidate {
  id: string;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  fullName: string;
  employeeCode: string;
  accessCodeHash: string | null;
}

/**
 * Find who is trying to sign in, by email or employee code.
 *
 * Returns the hash for the caller to verify rather than taking the code itself,
 * so the comparison stays in one place (`verifyAccessCode`, constant-time) and
 * this layer never handles a secret.
 *
 * Both identifiers are matched case-insensitively — neither is typed carefully
 * — and only active employees are considered, so deactivating someone revokes
 * their login in the same action that takes them off the rota.
 */
export async function findEmployeeForLogin(
  identifier: string
): Promise<EmployeeLoginCandidate | null> {
  const needle = identifier.trim().toLowerCase();
  if (!needle) return null;

  // Cross-tenant BY NECESSITY: sign-in is the one moment the tenant is not yet
  // known — resolving the identifier is what discovers it. Without this wrapper
  // RLS matches no rows, `rows.length !== 1` is true for every employee alive,
  // and the route reports "no unique active match" for a correct access code.
  // That is not hypothetical: it is how this function behaved from the day RLS
  // was switched on until 2026-08-13, and nothing failed loudly enough to say
  // so — the guard warns, the query returns zero rows, and a legitimate sign-in
  // is indistinguishable from a wrong code.
  const { rows } = await withAllTenants("employee sign-in — identifier lookup", () =>
    getPool().query<{
      id: string;
      organization_id: string;
      slug: string;
      org_name: string;
      full_name: string;
      employee_code: string;
      access_code_hash: string | null;
    }>(
      `select e.id, e.organization_id, o.slug, o.name as org_name,
            e.full_name, e.employee_code, e.access_code_hash
       from employees e
       join organizations o on o.id = e.organization_id
      where e.is_active = true
        and o.is_active = true
        and (lower(e.email) = $1 or lower(e.employee_code) = $1)
      limit 2`,
      [needle]
    )
  );

  // Two matches means the identifier is ambiguous across businesses — an
  // employee code like "ivan" can legitimately exist in more than one tenant.
  // Refusing is correct: signing them into whichever row sorted first would
  // hand someone another business's customer history.
  if (rows.length !== 1) return null;

  const row = rows[0];
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationSlug: row.slug,
    organizationName: row.org_name,
    fullName: row.full_name,
    employeeCode: row.employee_code,
    accessCodeHash: row.access_code_hash,
  };
}

/**
 * Stamp the successful sign-in.
 *
 * Takes the organisation because the caller has just resolved it and an
 * unscoped `update` here fails in the quietest way available: RLS matches no
 * rows, the statement SUCCEEDS with a row count of zero, and the caller's
 * best-effort try/catch has nothing to catch. `last_login_at` simply never
 * moves, which reads as "nobody has ever signed in" — the same thing an unused
 * account looks like.
 */
export async function recordEmployeeLogin(
  employeeId: string,
  organizationId: string
): Promise<void> {
  await withTenant(organizationId, () =>
    getPool().query(`update employees set last_login_at = now() where id = $1`, [employeeId])
  );
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
