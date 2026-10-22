import { getPool, withAllTenants } from "./client.js";

/**
 * Staff work — the admin's view of everything each staff member does in Nexus
 * (the owner, 22 Oct 2026: "check every chat from staff on WhatsApp, social
 * media and email, and monitor all their activity").
 *
 * ============================================================
 * WHAT COUNTS AS A STAFF MEMBER'S, AND WHY
 * ============================================================
 *
 * A chat is theirs when conversations.employee_id is them — the same rule that
 * keeps staff from seeing each other's (conversationVisibleTo).
 *
 * A REPLY is theirs whichever way it was sent. From Nexus, messages.sender_id
 * holds the employee id; typed on their phone (a WhatsApp Coexistence echo),
 * messages.employee_id does. Counting only one would show a staff member who
 * answers everything from the WhatsApp Business app as having sent nothing.
 *
 * A customer is WAITING when the latest message in an open chat is theirs —
 * last_direction = 'inbound'. Not "unread", which is per reader: a staff
 * member can have read a message and still not answered it.
 *
 * Every function runs cross-tenant on purpose: the admin looks across all
 * businesses. The route that serves these is behind operatorOnly.
 */

export type StaffStatus = "online" | "away" | "never-signed-in";

/** Online within ten minutes; never signed in is said, not shown as idle. */
export function staffStatus(input: {
  lastActiveAt: string | null;
  lastLoginAt: string | null;
  now?: Date;
}): StaffStatus {
  if (!input.lastActiveAt && !input.lastLoginAt) return "never-signed-in";
  const last = input.lastActiveAt ?? input.lastLoginAt;
  const now = input.now ?? new Date();
  return last && now.getTime() - new Date(last).getTime() <= 10 * 60_000 ? "online" : "away";
}

export interface StaffWorkPerson {
  employeeId: string;
  fullName: string;
  jobTitle: string | null;
  businessSlug: string;
  businessName: string;
  /** Their own WhatsApp number as WhatsApp shows it, when connected. */
  whatsappNumber: string | null;
  whatsappQuality: string | null;
  /** Providers connected to them personally: gmail, imap, tiktok, whatsapp… */
  connections: string[];
  chats: number;
  chatsByChannel: Record<string, number>;
  waiting: number;
  oldestWaitingAt: string | null;
  repliesToday: number;
  repliesWeek: number;
  openTasks: number;
  overdueTasks: number;
  upcomingBookings: number;
  campaigns30d: number;
  pausedCampaigns: number;
  lastActiveAt: string | null;
  status: StaffStatus;
}

export interface StaffWorkAttention {
  /** Customers waiting on a staff member for more than two hours, oldest first. */
  waitingLong: Array<{ conversationId: string; contactName: string | null; employeeName: string; businessSlug: string; since: string }>;
  waitingLongTotal: number;
  /** Open chats that belong to nobody, per business — the admin's to assign. */
  unowned: Array<{ businessSlug: string; businessName: string; count: number }>;
  staffWithoutNumber: number;
  pausedCampaigns: number;
}

const LAST_MESSAGE = `
  left join lateral (
    select m.direction as last_direction, m.created_at as last_at, m.body as last_body
      from messages m
     where m.conversation_id = c.id
     order by m.created_at desc
     limit 1
  ) lm on true`;

/** Everyone's work, for one business or all of them (null). */
export async function staffWorkOverview(
  organizationId: string | null,
  now: Date = new Date()
): Promise<{ people: StaffWorkPerson[]; attention: StaffWorkAttention }> {
  return withAllTenants("staff work: the admin looks across every staff member", async () => {
    const db = getPool();
    const { rows } = await db.query<{
      id: string;
      full_name: string;
      job_title: string | null;
      slug: string;
      name: string;
      whatsapp_number: string | null;
      whatsapp_phone_number_id: string | null;
      whatsapp_quality_rating: string | null;
      last_seen_at: string | null;
      last_login_at: string | null;
      connections: string[] | null;
      chats: string;
      by_channel: Record<string, number> | null;
      waiting: string;
      oldest_waiting_at: string | null;
      replies_today: string;
      replies_week: string;
      last_reply_at: string | null;
      open_tasks: string;
      overdue_tasks: string;
      upcoming_bookings: string;
      campaigns_30d: string;
      paused_campaigns: string;
    }>(
      `with conv as (
         select c.id, c.employee_id, c.channel, c.status, lm.last_direction, lm.last_at
           from conversations c
           ${LAST_MESSAGE}
          where ($1::uuid is null or coalesce(c.routed_organization_id, c.organization_id) = $1)
       )
       select e.id, e.full_name, e.job_title, o.slug, o.name,
              e.whatsapp_number, e.whatsapp_phone_number_id, e.whatsapp_quality_rating,
              e.last_seen_at, e.last_login_at,
              (select array_agg(distinct sc.provider) from social_connections sc where sc.employee_id = e.id) as connections,
              (select count(*) from conv where conv.employee_id = e.id) as chats,
              (select json_object_agg(x.channel, x.n)
                 from (select coalesce(conv.channel, 'whatsapp') as channel, count(*) as n
                         from conv where conv.employee_id = e.id group by 1) x) as by_channel,
              (select count(*) from conv
                where conv.employee_id = e.id and conv.status in ('open', 'pending')
                  and conv.last_direction = 'inbound') as waiting,
              (select min(conv.last_at) from conv
                where conv.employee_id = e.id and conv.status in ('open', 'pending')
                  and conv.last_direction = 'inbound') as oldest_waiting_at,
              (select count(*) from messages m
                where m.sender_type = 'human_agent' and (m.employee_id = e.id or m.sender_id = e.id::text)
                  and m.created_at >= (date_trunc('day', now() at time zone 'Asia/Dubai') at time zone 'Asia/Dubai')) as replies_today,
              (select count(*) from messages m
                where m.sender_type = 'human_agent' and (m.employee_id = e.id or m.sender_id = e.id::text)
                  and m.created_at >= now() - interval '7 days') as replies_week,
              (select max(m.created_at) from messages m
                where m.sender_type = 'human_agent' and (m.employee_id = e.id or m.sender_id = e.id::text)) as last_reply_at,
              (select count(*) from tasks t where t.employee_id = e.id and t.status = 'open') as open_tasks,
              (select count(*) from tasks t where t.employee_id = e.id and t.status = 'open' and t.due_at < now()) as overdue_tasks,
              (select count(*) from bookings b
                where b.employee_id = e.id and b.starts_at > now() and b.status <> 'cancelled') as upcoming_bookings,
              (select count(*) from broadcasts b
                where b.employee_id = e.id and b.created_at > now() - interval '30 days') as campaigns_30d,
              (select count(*) from broadcasts b where b.employee_id = e.id and b.status = 'paused') as paused_campaigns
         from employees e
         join organizations o on o.id = e.organization_id
        where e.is_active
          and o.slug <> 'review-demo'
          and ($1::uuid is null or e.organization_id = $1)
        order by o.name, e.full_name`,
      [organizationId]
    );

    const people: StaffWorkPerson[] = rows.map((r) => {
      const seen = [r.last_seen_at, r.last_reply_at].filter(Boolean) as string[];
      const lastActiveAt = seen.length ? seen.sort().at(-1)! : null;
      return {
        employeeId: r.id,
        fullName: r.full_name,
        jobTitle: r.job_title,
        businessSlug: r.slug,
        businessName: r.name,
        whatsappNumber: r.whatsapp_phone_number_id ? r.whatsapp_number : null,
        whatsappQuality: r.whatsapp_quality_rating,
        connections: (r.connections ?? []).filter(Boolean),
        chats: Number(r.chats),
        chatsByChannel: r.by_channel ?? {},
        waiting: Number(r.waiting),
        oldestWaitingAt: r.oldest_waiting_at,
        repliesToday: Number(r.replies_today),
        repliesWeek: Number(r.replies_week),
        openTasks: Number(r.open_tasks),
        overdueTasks: Number(r.overdue_tasks),
        upcomingBookings: Number(r.upcoming_bookings),
        campaigns30d: Number(r.campaigns_30d),
        pausedCampaigns: Number(r.paused_campaigns),
        lastActiveAt,
        status: staffStatus({ lastActiveAt, lastLoginAt: r.last_login_at, now }),
      };
    });

    const waitingLong = await db.query<{
      id: string;
      display_name: string | null;
      full_name: string;
      slug: string;
      last_at: string;
      total: string;
    }>(
      `select c.id, ct.display_name, e.full_name, o.slug, lm.last_at, count(*) over () as total
         from conversations c
         join employees e on e.id = c.employee_id
         join organizations o on o.id = coalesce(c.routed_organization_id, c.organization_id)
         left join contacts ct on ct.id = c.contact_id
         ${LAST_MESSAGE}
        where c.status in ('open', 'pending')
          and lm.last_direction = 'inbound'
          and lm.last_at < now() - interval '2 hours'
          and ($1::uuid is null or coalesce(c.routed_organization_id, c.organization_id) = $1)
        order by lm.last_at asc
        limit 10`,
      [organizationId]
    );

    const unowned = await db.query<{ slug: string; name: string; n: string }>(
      `select o.slug, o.name, count(*) as n
         from conversations c
         join organizations o on o.id = coalesce(c.routed_organization_id, c.organization_id)
        where c.employee_id is null
          and c.status in ('open', 'pending')
          and o.slug <> 'review-demo'
          and ($1::uuid is null or o.id = $1)
        group by o.slug, o.name
        order by count(*) desc`,
      [organizationId]
    );

    return {
      people,
      attention: {
        waitingLong: waitingLong.rows.map((r) => ({
          conversationId: r.id,
          contactName: r.display_name,
          employeeName: r.full_name,
          businessSlug: r.slug,
          since: r.last_at,
        })),
        waitingLongTotal: Number(waitingLong.rows[0]?.total ?? 0),
        unowned: unowned.rows.map((r) => ({ businessSlug: r.slug, businessName: r.name, count: Number(r.n) })),
        staffWithoutNumber: people.filter((p) => !p.whatsappNumber).length,
        pausedCampaigns: people.reduce((sum, p) => sum + p.pausedCampaigns, 0),
      },
    };
  });
}

export interface StaffConversation {
  id: string;
  businessSlug: string;
  contactName: string | null;
  contactWaId: string | null;
  channel: string;
  status: string;
  lastDirection: string | null;
  lastAt: string | null;
  lastBody: string | null;
  waiting: boolean;
}

export interface StaffTimelineItem {
  kind: "reply" | "note" | "event" | "task" | "booking" | "campaign" | "connected";
  what: string;
  at: string;
  conversationId: string | null;
}

/** One person's chats on every channel, and what they did, newest first. */
export async function staffMemberWork(employeeId: string): Promise<{
  conversations: StaffConversation[];
  timeline: StaffTimelineItem[];
} | null> {
  return withAllTenants("staff work: the admin opens one staff member's work", async () => {
    const db = getPool();
    const employee = await db.query<{ id: string; whatsapp_connected_at: string | null; whatsapp_number: string | null }>(
      `select id, whatsapp_connected_at, whatsapp_number from employees where id = $1`,
      [employeeId]
    );
    if (!employee.rows[0]) return null;

    const conversations = await db.query<{
      id: string;
      slug: string;
      display_name: string | null;
      wa_id: string | null;
      channel: string | null;
      status: string;
      last_direction: string | null;
      last_at: string | null;
      last_body: string | null;
    }>(
      `select c.id, o.slug, ct.display_name, ct.wa_id, c.channel, c.status,
              lm.last_direction, lm.last_at, left(lm.last_body, 160) as last_body
         from conversations c
         join organizations o on o.id = coalesce(c.routed_organization_id, c.organization_id)
         left join contacts ct on ct.id = c.contact_id
         ${LAST_MESSAGE}
        where c.employee_id = $1 or $1 = any(coalesce(c.collaborator_ids, '{}'))
        order by lm.last_at desc nulls last
        limit 300`,
      [employeeId]
    );

    const replies = await db.query<{ at: string; conversation_id: string; display_name: string | null; channel: string | null; body: string | null }>(
      `select m.created_at as at, m.conversation_id, ct.display_name, c.channel, left(m.body, 80) as body
         from messages m
         join employees e on e.id = $1
         join conversations c on c.id = m.conversation_id
         left join contacts ct on ct.id = c.contact_id
        where m.sender_type = 'human_agent' and (m.employee_id = e.id or m.sender_id = e.id::text)
        order by m.created_at desc
        limit 60`,
      [employeeId]
    );
    const notes = await db.query<{ at: string; conversation_id: string; body: string }>(
      `select created_at as at, conversation_id, left(body, 80) as body
         from conversation_notes where author = $1::text order by created_at desc limit 30`,
      [employeeId]
    );
    const events = await db.query<{ at: string; conversation_id: string; kind: string; subject_name: string | null }>(
      `select created_at as at, conversation_id, kind, subject_name
         from conversation_events where actor = $1::text order by created_at desc limit 30`,
      [employeeId]
    );
    const tasks = await db.query<{ at: string; conversation_id: string | null; title: string; status: string }>(
      `select coalesce(completed_at, created_at) as at, conversation_id, title, status
         from tasks where employee_id = $1 order by coalesce(completed_at, created_at) desc limit 30`,
      [employeeId]
    );
    const bookings = await db.query<{ at: string; conversation_id: string | null; subject: string | null; starts_at: string }>(
      `select created_at as at, conversation_id, subject, starts_at
         from bookings where employee_id = $1 order by created_at desc limit 30`,
      [employeeId]
    );
    const campaigns = await db.query<{ at: string; status: string; template: string | null; total: string }>(
      `select b.created_at as at, b.status, t.meta_template_name as template,
              (select count(*) from broadcast_recipients r where r.broadcast_id = b.id) as total
         from broadcasts b left join message_templates t on t.id = b.template_id
        where b.employee_id = $1 order by b.created_at desc limit 20`,
      [employeeId]
    );

    const channelName = (channel: string | null) =>
      ({ whatsapp: "WhatsApp", email: "email", facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok" } as Record<string, string>)[
        channel ?? "whatsapp"
      ] ?? channel ?? "WhatsApp";

    const timeline: StaffTimelineItem[] = [
      ...replies.rows.map((r) => ({
        kind: "reply" as const,
        what: `Replied to ${r.display_name ?? "a customer"} on ${channelName(r.channel)}${r.body ? ` — “${r.body}”` : ""}`,
        at: r.at,
        conversationId: r.conversation_id,
      })),
      ...notes.rows.map((r) => ({ kind: "note" as const, what: `Added a note: “${r.body}”`, at: r.at, conversationId: r.conversation_id })),
      ...events.rows.map((r) => ({
        kind: "event" as const,
        what: `${r.kind[0].toUpperCase()}${r.kind.slice(1)} a chat${r.subject_name ? ` (${r.subject_name})` : ""}`,
        at: r.at,
        conversationId: r.conversation_id,
      })),
      ...tasks.rows.map((r) => ({
        kind: "task" as const,
        what: `${r.status === "done" || r.status === "completed" ? "Completed" : "Has"} a task: ${r.title}`,
        at: r.at,
        conversationId: r.conversation_id,
      })),
      ...bookings.rows.map((r) => ({
        kind: "booking" as const,
        what: `Booked ${r.subject ?? "an appointment"} for ${new Date(r.starts_at).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" })}`,
        at: r.at,
        conversationId: r.conversation_id,
      })),
      ...campaigns.rows.map((r) => ({
        kind: "campaign" as const,
        what: `Sent a campaign (${r.template ?? "a message"}) to ${r.total} people — ${r.status}`,
        at: r.at,
        conversationId: null,
      })),
      ...(employee.rows[0].whatsapp_connected_at
        ? [
            {
              kind: "connected" as const,
              what: `Connected their WhatsApp ${employee.rows[0].whatsapp_number ?? "number"}`,
              at: employee.rows[0].whatsapp_connected_at,
              conversationId: null,
            },
          ]
        : []),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, 80);

    return {
      conversations: conversations.rows.map((r) => ({
        id: r.id,
        businessSlug: r.slug,
        contactName: r.display_name,
        contactWaId: r.wa_id,
        channel: r.channel ?? "whatsapp",
        status: r.status,
        lastDirection: r.last_direction,
        lastAt: r.last_at,
        lastBody: r.last_body,
        waiting: (r.status === "open" || r.status === "pending") && r.last_direction === "inbound",
      })),
      timeline,
    };
  });
}
