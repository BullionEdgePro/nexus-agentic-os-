import { getPool } from "./client.js";

/**
 * Follow-ups, attached to the conversation they came from.
 *
 * THE GAP. A customer messages, the agent answers, an employee takes over and
 * gets a handover brief telling them what was already promised. Then the trail
 * stops. What the employee agreed to DO — call back Tuesday, chase the
 * attestation, send the quote — has been living in their head. On a platform
 * whose premise is that conversations become work, the work was the one thing
 * not being recorded.
 *
 * WHAT THIS IS NOT. Not boards, not swimlanes, not dependencies, not Monday
 * parity. ARCHITECTURE-ABOS.md §F7 is explicit that parity is years and that
 * "boards + tasks tied to conversations is weeks". This is the second thing.
 */

export type TaskStatus = "open" | "done" | "cancelled";

export interface TaskRecord {
  id: string;
  organizationId: string;
  businessName: string;
  businessSlug: string;
  conversationId: string | null;
  contactId: string | null;
  contactName: string | null;
  contactWaId: string | null;
  employeeId: string | null;
  employeeName: string | null;
  title: string;
  notes: string | null;
  dueAt: string | null;
  status: TaskStatus;
  /** Computed against the database clock, not the browser's. See below. */
  isOverdue: boolean;
  completedAt: string | null;
  completedByName: string | null;
  createdAt: string;
}

interface TaskRow {
  id: string;
  organization_id: string;
  business_name: string;
  business_slug: string;
  conversation_id: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_wa_id: string | null;
  employee_id: string | null;
  employee_name: string | null;
  title: string;
  notes: string | null;
  due_at: string | null;
  status: TaskStatus;
  is_overdue: boolean;
  completed_at: string | null;
  completed_by_name: string | null;
  created_at: string;
}

/**
 * Overdue is decided by the database, not by the client.
 *
 * The obvious alternative — ship `dueAt` and compare it to `Date.now()` in the
 * browser — makes the single most operationally important flag on this page
 * depend on the correctness of an operator's laptop clock. A machine an hour
 * fast shows a column of false alarms; one an hour slow hides the thing that is
 * actually late. `due_at` is timestamptz, so `< now()` is unambiguous
 * regardless of where either end is sitting.
 */
const TASK_FIELDS = `
  t.id, t.organization_id,
  o.name  as business_name,
  o.slug  as business_slug,
  t.conversation_id, t.contact_id,
  ct.display_name as contact_name,
  ct.wa_id        as contact_wa_id,
  t.employee_id,
  e.full_name     as employee_name,
  t.title, t.notes, t.due_at, t.status,
  (t.status = 'open' and t.due_at is not null and t.due_at < now()) as is_overdue,
  t.completed_at,
  cb.full_name    as completed_by_name,
  t.created_at
`;

const TASK_JOINS = `
  join organizations o on o.id = t.organization_id
  left join contacts  ct on ct.id = t.contact_id
  left join employees e  on e.id = t.employee_id
  left join employees cb on cb.id = t.completed_by
`;

/** Plain reads: the table is the source. */
const TASK_SELECT = `select ${TASK_FIELDS} from tasks t ${TASK_JOINS}`;

/**
 * Reads that follow a write in the SAME statement — and why they cannot just
 * re-read the table.
 *
 * A data-modifying CTE's effects are invisible to the rest of the statement it
 * lives in: every part of the query runs against the snapshot taken when the
 * statement began. So
 *
 *     with inserted as (insert into tasks ... returning id)
 *     select ... from tasks t where t.id = (select id from inserted)
 *
 * reads `tasks` as it was BEFORE the insert and matches nothing. The first
 * version of this file did exactly that, in all four writers, and the failures
 * were not equally loud:
 *
 *   insert — no prior row, zero rows returned, `rows[0].id` throws. Caught the
 *            first time it ran.
 *   update — the row already exists, so it matches, and comes back with its
 *            PRE-UPDATE values. The write commits and the caller is told the
 *            task is still open. Nothing errors. That one would have shipped.
 *
 * Selecting FROM the CTE takes the returned rows directly. The joined tables
 * are untouched by the write, so their snapshot is fine.
 */
const returning = (cte: string) => `select ${TASK_FIELDS} from ${cte} t ${TASK_JOINS}`;

function toTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    businessName: row.business_name,
    businessSlug: row.business_slug,
    conversationId: row.conversation_id,
    contactId: row.contact_id,
    contactName: row.contact_name,
    contactWaId: row.contact_wa_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    title: row.title,
    notes: row.notes,
    dueAt: row.due_at,
    status: row.status,
    isOverdue: row.is_overdue,
    completedAt: row.completed_at,
    completedByName: row.completed_by_name,
    createdAt: row.created_at,
  };
}

export interface TaskFilter {
  /** One business, or every business the caller's context can see. */
  organizationId?: string | null;
  /** One person's list. */
  employeeId?: string | null;
  /** Defaults to open only — a done list nobody asked for buries the live one. */
  status?: TaskStatus | "all";
  limit?: number;
}

/**
 * Ordering is the feature.
 *
 * A flat list sorted by creation date is a list nobody reads twice. These sort
 * by when the work is due, with undated tasks last: something with a date is a
 * commitment to a customer, something without is an intention, and the two
 * should not interleave. `nulls last` is doing that work explicitly — Postgres
 * would otherwise sort nulls first on an ascending order and put every vague
 * intention above tomorrow morning's callback.
 */
export async function listTasks(filter: TaskFilter = {}): Promise<TaskRecord[]> {
  const status = filter.status ?? "open";
  const { rows } = await getPool().query<TaskRow>(
    `${TASK_SELECT}
      where ($1::uuid is null or t.organization_id = $1)
        and ($2::uuid is null or t.employee_id = $2)
        and ($3::text = 'all' or t.status = $3)
      order by
        case when t.status = 'open' then 0 else 1 end,
        t.due_at asc nulls last,
        t.created_at desc
      limit $4`,
    [filter.organizationId ?? null, filter.employeeId ?? null, status, filter.limit ?? 200]
  );
  return rows.map(toTask);
}

export async function listTasksForConversation(conversationId: string): Promise<TaskRecord[]> {
  const { rows } = await getPool().query<TaskRow>(
    `${TASK_SELECT}
      where t.conversation_id = $1
      order by case when t.status = 'open' then 0 else 1 end,
               t.due_at asc nulls last, t.created_at desc`,
    [conversationId]
  );
  return rows.map(toTask);
}

export interface TaskCounts {
  open: number;
  overdue: number;
  unassigned: number;
}

/**
 * The three numbers worth putting on a dashboard.
 *
 * `unassigned` counts only OPEN tasks. A finished task with no owner recorded
 * is a bookkeeping detail; an open one is work nobody has agreed to do, and it
 * will still be undone next week. Counting the two together would let closed
 * history inflate the number until the operator stops believing it.
 */
export async function countTasks(organizationId?: string | null): Promise<TaskCounts> {
  const { rows } = await getPool().query<{ open: string; overdue: string; unassigned: string }>(
    `select
       count(*) filter (where status = 'open')::text as open,
       count(*) filter (where status = 'open' and due_at is not null and due_at < now())::text as overdue,
       count(*) filter (where status = 'open' and employee_id is null)::text as unassigned
     from tasks
     where ($1::uuid is null or organization_id = $1)`,
    [organizationId ?? null]
  );
  return {
    open: Number(rows[0]?.open ?? 0),
    overdue: Number(rows[0]?.overdue ?? 0),
    unassigned: Number(rows[0]?.unassigned ?? 0),
  };
}

export interface CreateTaskInput {
  /** Ignored when `conversationId` is given — see the note in createTask. */
  organizationId?: string | null;
  conversationId?: string | null;
  contactId?: string | null;
  employeeId?: string | null;
  title: string;
  notes?: string | null;
  dueAt?: string | null;
}

const TITLE_MAX = 200;
const NOTES_MAX = 4000;

export async function createTask(input: CreateTaskInput): Promise<TaskRecord> {
  const title = input.title.trim();
  if (!title) throw new Error("A task needs a title — that is the part someone reads in a list.");
  if (title.length > TITLE_MAX) {
    throw new Error(`Keep the title under ${TITLE_MAX} characters; put the detail in the notes.`);
  }
  const notes = input.notes?.trim() || null;
  if (notes && notes.length > NOTES_MAX) {
    throw new Error(`Notes are limited to ${NOTES_MAX} characters.`);
  }

  if (input.dueAt) {
    // Rejected here rather than at the column. Postgres would raise a type
    // error that surfaces as a 500 and tells the operator nothing about which
    // field they got wrong.
    const parsed = Date.parse(input.dueAt);
    if (Number.isNaN(parsed)) throw new Error(`"${input.dueAt}" is not a date I can read.`);
  }

  let organizationId = input.organizationId ?? null;
  let contactId = input.contactId ?? null;

  if (input.conversationId) {
    // THE BUSINESS IS TAKEN FROM THE CONVERSATION, NOT FROM THE CALLER.
    //
    // Five businesses answer one WhatsApp number, so every conversation is
    // OWNED by the number's owner (Zipicka) while `routed_organization_id`
    // holds the business the enquiry was actually routed to. Trusting a caller
    // -supplied organization_id — or reading the wrong column here — files
    // every follow-up from a shared-number conversation under Zipicka. The law
    // firm's tasks would then be invisible to the law firm and visible to a
    // retailer, and nothing would look broken: there would simply be a busy
    // list under one business and empty lists under four.
    //
    // listConversationsForEmployee already resolves the business this way; the
    // coalesce is the same one, deliberately.
    const { rows } = await getPool().query<{ organization_id: string; contact_id: string }>(
      `select coalesce(routed_organization_id, organization_id) as organization_id, contact_id
         from conversations where id = $1`,
      [input.conversationId]
    );
    if (!rows[0]) throw new Error("That conversation does not exist, or is not visible from here.");
    organizationId = rows[0].organization_id;
    contactId = contactId ?? rows[0].contact_id;
  }

  if (!organizationId) {
    throw new Error("A task must belong to a business — pass a conversation or an organization.");
  }

  if (input.employeeId) {
    // A foreign key to employees does not say WHICH business's employee. Left
    // unchecked, an operator could assign ABR's litigation follow-up — customer
    // name, phone number and all — to a shop assistant at a different company,
    // and it would appear on that person's list as ordinary work. RLS does not
    // catch this: both rows are legitimately visible to a cross-tenant operator
    // context, which is exactly the context the deck runs in.
    const { rows } = await getPool().query<{ n: string }>(
      `select count(*)::text as n from employees
        where id = $1 and organization_id = $2 and is_active = true`,
      [input.employeeId, organizationId]
    );
    if (Number(rows[0]?.n ?? 0) !== 1) {
      throw new Error("That person does not work for this business, so the task cannot be theirs.");
    }
  }

  const { rows } = await getPool().query<TaskRow>(
    `with inserted as (
       insert into tasks (organization_id, conversation_id, contact_id, employee_id, title, notes, due_at)
       values ($1, $2, $3, $4, $5, $6, $7::timestamptz)
       returning *
     )
     ${returning("inserted")}`,
    [
      organizationId,
      input.conversationId ?? null,
      contactId,
      input.employeeId ?? null,
      title,
      notes,
      input.dueAt ?? null,
    ]
  );
  return toTask(rows[0]);
}

/**
 * THE `withinOrganization` ARGUMENT ON EVERY MUTATOR BELOW.
 *
 * `/api/tasks` carries no organization slug, so it runs in a CROSS-TENANT
 * database context — RLS is wide open for the length of that request by design,
 * because the operator deck genuinely spans all five businesses. Which means
 * nothing underneath these functions will stop an employee at one company from
 * closing, cancelling or reassigning another company's follow-up if they hold
 * its id. The row would change, the response would look entirely ordinary, and
 * the only trace would be a task quietly marked done that nobody did.
 *
 * So the constraint travels with the query. Null means "no restriction" and is
 * what an operator passes; an employee's session organization is what everyone
 * else passes. Expressed as `$n::uuid is null or organization_id = $n` rather
 * than as a caller-side check, because a caller-side check is one someone
 * forgets to write on the next endpoint.
 */

/**
 * Close a task, recording who closed it.
 *
 * `completedBy` is optional because an operator has no employee row — they
 * administer the platform rather than work in one of its businesses. So a task
 * closed from the deck records the time but not a person, and the UI says
 * "closed from the deck" rather than inventing an owner.
 *
 * Guarded on `status = 'open'` so a second click cannot overwrite the original
 * completion time and the person credited with it.
 */
export async function completeTask(
  taskId: string,
  completedBy?: string | null,
  withinOrganization?: string | null
): Promise<TaskRecord | null> {
  const { rows } = await getPool().query<TaskRow>(
    `with updated as (
       update tasks
          set status = 'done', completed_at = now(), completed_by = $2, updated_at = now()
        where id = $1 and status = 'open'
          and ($3::uuid is null or organization_id = $3)
        returning *
     )
     ${returning("updated")}`,
    [taskId, completedBy ?? null, withinOrganization ?? null]
  );
  return rows[0] ? toTask(rows[0]) : null;
}

/**
 * Reopen a closed task, or cancel an open one.
 *
 * Cancelling rather than deleting, and reopening rather than re-creating, both
 * for the same reason: the row is the record that something was owed to a
 * customer. Deleting it loses the fact that anyone ever agreed to it.
 */
export async function setTaskStatus(
  taskId: string,
  status: TaskStatus,
  withinOrganization?: string | null
): Promise<TaskRecord | null> {
  const { rows } = await getPool().query<TaskRow>(
    `with updated as (
       update tasks
          set status = $2,
              -- Reopening clears the completion record. Leaving it would show a
              -- live task stamped with the date it was finished and the name of
              -- whoever finished it, which reads as data corruption.
              completed_at = case when $2 = 'done' then completed_at else null end,
              completed_by = case when $2 = 'done' then completed_by else null end,
              updated_at = now()
        where id = $1 and status <> $2
          and ($3::uuid is null or organization_id = $3)
        returning *
     )
     ${returning("updated")}`,
    [taskId, status, withinOrganization ?? null]
  );
  return rows[0] ? toTask(rows[0]) : null;
}

/** Hand a task to someone else, or take the owner off it. */
export async function assignTask(
  taskId: string,
  employeeId: string | null,
  withinOrganization?: string | null
): Promise<TaskRecord | null> {
  if (employeeId) {
    // Same cross-business check as createTask, for the same reason — reassignment
    // is the other door into the identical mistake.
    const { rows } = await getPool().query<{ n: string }>(
      `select count(*)::text as n
         from tasks t
         join employees e on e.id = $2
                         and e.organization_id = t.organization_id
                         and e.is_active = true
        where t.id = $1`,
      [taskId, employeeId]
    );
    if (Number(rows[0]?.n ?? 0) !== 1) {
      throw new Error("That person does not work for this business, so the task cannot be theirs.");
    }
  }

  const { rows } = await getPool().query<TaskRow>(
    `with updated as (
       update tasks set employee_id = $2, updated_at = now()
        where id = $1 and ($3::uuid is null or organization_id = $3)
        returning *
     )
     ${returning("updated")}`,
    [taskId, employeeId, withinOrganization ?? null]
  );
  return rows[0] ? toTask(rows[0]) : null;
}
