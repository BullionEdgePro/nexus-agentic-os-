import { Hono } from "hono";
import {
  listTasks,
  listBookings,
  listMyClients,
  referralsForEmployee,
  findEmployeeById,
  findOrganizationById,
  withTenant,
  getPool,
} from "@nexus/db";
import { deskOf } from "./my-desk.js";

/**
 * What one person has to do today.
 *
 * ============================================================
 * A SCREEN THAT ASKED FOR WORK INSTEAD OF SHOWING IT
 * ============================================================
 *
 * A staff member's front page was a greeting, an empty list and a form for
 * logging a lead. All three are useful and none of them answers the question
 * somebody actually opens a console with: what needs me, and in what order.
 *
 * So this assembles it in ONE request, server side, already ordered. The
 * alternative — five fetches from the browser and a sort in the component —
 * gives four loading states, four ways to half-fail, and a page whose ordering
 * lives in whichever file was edited last.
 *
 * Everything is keyed on the employee id in the SESSION. Nothing here takes an
 * id from the caller.
 *
 * ============================================================
 * WHY IT ALSO RETURNS THINGS TO SAY
 * ============================================================
 *
 * `nudges` are computed here rather than in the component because they are
 * facts about the data, not decoration: a client book nobody has ever messaged,
 * a published link that has brought nothing, a missing number that quietly
 * makes handover impossible. A person cannot ask a question they do not know to
 * ask, and every one of these is invisible until something says it out loud.
 *
 * Each is emitted only when it is genuinely actionable, and several are guarded
 * on each other -- "nobody has used your link" is silent while there is no
 * number to hand people to, because fixing the second is the prerequisite for
 * the first. A nudge that appears when there is nothing to do, or that asks for
 * something impossible, is what makes people stop reading nudges.
 */
export const myDayRoute = new Hono();

interface Nudge {
  kind: string;
  severity: "urgent" | "warn" | "info";
  text: string;
  href?: string;
}

myDayRoute.get("/day", async (c) => {
  const desk = deskOf(c);
  if ("error" in desk) return c.json({ error: desk.error }, 403);

  const [employee, organization] = await withTenant(desk.organizationId, async () => [
    await findEmployeeById(desk.employeeId),
    await findOrganizationById(desk.organizationId),
  ]);
  if (!employee || !organization) return c.json({ error: "Account not found." }, 404);

  const [tasks, bookings, clients, referrals, waiting] = await withTenant(
    desk.organizationId,
    async () => [
      await listTasks({ organizationId: desk.organizationId, employeeId: desk.employeeId, limit: 50 }),
      await listBookings({
        organizationId: desk.organizationId,
        employeeId: desk.employeeId,
        upcomingOnly: true,
        limit: 20,
      }),
      await listMyClients(desk.organizationId, desk.employeeId, { limit: 500 }),
      await referralsForEmployee(desk.employeeId),
      await waitingOnMe(desk.organizationId, desk.employeeId),
    ]
  );

  const overdue = tasks.filter((task) => task.isOverdue);
  const neverSpoken = clients.filter((client) => !client.hasSpoken);

  // ---- the nudges -----------------------------------------------------
  const nudges: Nudge[] = [];

  if (!employee.whatsappNumber) {
    // The quietest failure on the platform: their link works, brings people in,
    // and the handover it promises cannot happen. Nothing else says so.
    nudges.push({
      kind: "no-number",
      severity: "warn",
      text:
        "You have no WhatsApp number on file, so customers who come through your link " +
        "cannot be handed to you. Set it on My clients — the field is on the same panel " +
        "that explains it.",
      href: "/deck/my-clients",
    });
  }

  if (clients.length > 0 && referrals.conversations === 0 && employee.whatsappNumber) {
    nudges.push({
      kind: "link-unused",
      severity: "info",
      text:
        "Nobody has come through your link yet. It only works where people can see it — a bio, a signature, " +
        "a story. Copy it from My clients.",
      href: "/deck/my-clients",
    });
  }

  if (neverSpoken.length >= 3) {
    nudges.push({
      kind: "silent-clients",
      severity: "info",
      text: `${neverSpoken.length} people in your book have never written in. A campaign is the only way to reach them first.`,
      href: "/deck/my-campaigns",
    });
  }

  if (overdue.length > 0) {
    nudges.push({
      kind: "overdue",
      severity: "urgent",
      text: `${overdue.length} follow-${overdue.length === 1 ? "up is" : "ups are"} past due.`,
      href: "/deck/tasks",
    });
  }

  return c.json({
    who: {
      // The NAME, which is the whole reason this endpoint returns a person at
      // all: the page greeted people with their email address because the
      // session carries a subject and not a name.
      fullName: employee.fullName,
      firstName: employee.fullName.trim().split(/\s+/)[0],
      jobTitle: employee.jobTitle,
      businessName: organization.name,
      whatsappNumber: employee.whatsappNumber,
    },
    waiting,
    tasks: tasks.slice(0, 8).map((task) => ({
      id: task.id,
      title: task.title,
      dueAt: task.dueAt,
      isOverdue: task.isOverdue,
      contactName: task.contactName,
      conversationId: task.conversationId,
    })),
    appointments: bookings.slice(0, 6).map((booking) => ({
      id: booking.id,
      subject: booking.subject,
      startsAt: booking.startsAt,
      // The BUSINESS's zone, carried on the row. An appointment is a time
      // somebody physically arrives somewhere, so rendering it in the reader's
      // local zone would show a wrong hour they would then repeat aloud.
      timezone: booking.businessTimezone,
      contactName: booking.contactName,
    })),
    counts: {
      waiting: waiting.length,
      openTasks: tasks.length,
      overdue: overdue.length,
      appointments: bookings.length,
      clients: clients.length,
      neverSpoken: neverSpoken.length,
      referredConversations: referrals.conversations,
    },
    nudges,
  });
});

/**
 * Customers whose last word was theirs, on conversations assigned to this
 * person.
 *
 * ============================================================
 * "WAITING" MEANS THEY SPOKE LAST, NOT THAT A ROW EXISTS
 * ============================================================
 *
 * The tempting query is "open conversations assigned to me", which counts every
 * thread anybody ever handed over, most of them finished. This asks the
 * narrower and much more useful question: is the most recent message in this
 * conversation from the CUSTOMER? If it is, somebody is holding their phone
 * waiting, and that is the only list worth putting at the top of a screen.
 *
 * Ordered oldest-first on purpose. Newest-first shows the person who has waited
 * least, which is the wrong end of a queue.
 */
async function waitingOnMe(organizationId: string, employeeId: string) {
  const { rows } = await getPool().query<{
    conversation_id: string;
    contact_name: string | null;
    wa_id: string;
    last_at: Date;
    hours: string;
  }>(
    `select c.id                                   as conversation_id,
            ct.display_name                        as contact_name,
            ct.wa_id,
            m.created_at                           as last_at,
            extract(epoch from (now() - m.created_at)) / 3600 as hours
       from conversations c
       join contacts ct on ct.id = c.contact_id
       join lateral (
         select direction, created_at
           from messages
          where conversation_id = c.id
          order by created_at desc
          limit 1
       ) m on true
      where c.employee_id = $2
        and coalesce(c.routed_organization_id, c.organization_id) = $1
        and c.status in ('open', 'pending')
        and m.direction = 'inbound'
      order by m.created_at asc
      limit 10`,
    [organizationId, employeeId]
  );

  return rows.map((row) => ({
    conversationId: row.conversation_id,
    contactName: row.contact_name,
    waId: row.wa_id,
    waitingHours: Math.round(Number(row.hours) * 10) / 10,
  }));
}
