import { Hono } from "hono";
import {
  findOrganizationBySlug,
  findOrganizationById,
  findConversationById,
  listEmployees,
  findEmployeeById,
  createEmployee,
  deactivateEmployee,
  assignConversationToEmployee,
  listConversationsForEmployee,
  setConversationHandoff,
  pauseAiForContact,
  getConversationRouting,
  setEmployeeAccessCodeHash,
  updateEmployeeSchedule,
  assignEmployeeWhatsAppNumber,
  listCalendars,
  connectCalendar,
  disconnectCalendar,
} from "@nexus/db";
import { listWabaNumbers } from "../lib/whatsapp-client.js";
import {
  buildDirectContact,
  normalizeWhatsAppNumber,
  resolvePresence,
  generateAccessCode,
  hashAccessCode,
  parseWeeklySchedule,
  weeklyHours,
} from "@nexus/employees";
import {
  captureEmployeeLead,
  listEmployeeLeads,
  labelsForAssessments,
  leadScorerAccuracy,
  recordLeadLabel,
  isLeadOutcome,
} from "@nexus/leads";
import { publishInboxEvent } from "../lib/pubsub.js";
import { buildHandoverBrief } from "@nexus/agents";
import { assertPublicUrl } from "@nexus/knowledge";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/** Who is asking. An unattributed calendar connection is one nobody owns. */
function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

/**
 * Employee profiles, assignment, and the bridge to an employee's own WhatsApp.
 *
 * The platform runs one WhatsApp Business number for every tenant. Employees do
 * not get their own — each additional Business API number costs money and needs
 * Meta approval — so an employee reaches their assigned customers from the
 * WhatsApp already on their phone, via a click-to-chat link this route builds.
 *
 * Mounted under /api/*, so `requireAuth` covers everything here.
 */
export const employeesRoute = new Hono();

// ============================================================
// Profiles
// ============================================================

employeesRoute.get("/:slug/employees", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const employees = await listEmployees(organization.id);

  // Presence is resolved here rather than stored, because it is a function of
  // the clock: a schedule that says "online until 18:00" is not a fact anyone
  // can write down once. Returning it alongside the profile means the deck
  // never has to re-implement the precedence rules.
  return c.json({
    employees: employees.map((employee) => ({
      ...employee,
      // Never leave the building. This is a human-only attestation the AI twin
      // is forbidden to reproduce; the API has no reason to hand it out either.
      digitalSignature: undefined,
      presence: resolvePresence(employee),
      whatsappReady: normalizeWhatsAppNumber(employee.whatsappNumber) !== null,
      // Derived here rather than in the browser so the list can say "0 hours"
      // out loud. An employee with an empty rota is not bookable and will not
      // be offered for escalation — true since the employee layer shipped, and
      // invisible on this screen until now, which is how every business ended
      // up permanently off-shift without anybody seeing a fault.
      weeklyHours: weeklyHours(employee.workingHours),
    })),
  });
});

employeesRoute.post("/:slug/employees", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  if (!fullName) return c.json({ error: "fullName is required" }, 400);

  // Derived from the name when not supplied, because an employee code is an
  // implementation detail to the person filling in this form.
  const employeeCode =
    typeof body.employeeCode === "string" && body.employeeCode.trim()
      ? body.employeeCode.trim().toLowerCase()
      : fullName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  if (!employeeCode) return c.json({ error: "Could not derive an employee code from that name" }, 400);

  // Validated rather than stored as typed: an unusable number here produces a
  // dead click-to-chat link later, and the person who could fix it is the one
  // filling in this form right now.
  const rawWhatsApp = typeof body.whatsappNumber === "string" ? body.whatsappNumber : null;
  if (rawWhatsApp && rawWhatsApp.trim() && !normalizeWhatsAppNumber(rawWhatsApp)) {
    return c.json(
      { error: "That WhatsApp number is not a valid international number — include the country code, e.g. +971 50 123 4567" },
      400
    );
  }

  const employee = await createEmployee({
    organizationId: organization.id,
    employeeCode,
    fullName,
    email: typeof body.email === "string" ? body.email.trim() || null : null,
    jobTitle: typeof body.jobTitle === "string" ? body.jobTitle.trim() || null : null,
    department: typeof body.department === "string" ? body.department.trim() || null : null,
    whatsappNumber: rawWhatsApp?.trim() || null,
    timezone: typeof body.timezone === "string" ? body.timezone : undefined,
    languages: Array.isArray(body.languages) ? (body.languages as string[]) : undefined,
    skills: Array.isArray(body.skills) ? (body.skills as string[]) : undefined,
    twinEnabled: typeof body.twinEnabled === "boolean" ? body.twinEnabled : undefined,
    aiPersonality: typeof body.aiPersonality === "string" ? body.aiPersonality.trim() || null : null,
    responseStyle: typeof body.responseStyle === "string" ? body.responseStyle.trim() || null : null,
    humanFirst: typeof body.humanFirst === "boolean" ? body.humanFirst : undefined,
  });

  logger.info(
    { organizationSlug: organization.slug, employeeCode: employee.employeeCode },
    "Employee profile saved"
  );

  return c.json({ employee: { ...employee, digitalSignature: undefined } }, 201);
});

employeesRoute.delete("/:slug/employees/:employeeId", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const employee = await findEmployeeById(c.req.param("employeeId"));
  if (!employee || employee.organizationId !== organization.id) {
    return c.json({ error: "Employee not found" }, 404);
  }

  const changed = await deactivateEmployee(employee.id);
  return c.json({ deactivated: changed, employeeId: employee.id });
});

/**
 * Set an employee's rota.
 *
 * THE MISSING HALF OF THE EMPLOYEE LAYER. Nothing anywhere could write
 * `working_hours` until 2026-08-14, so every employee created through the
 * product had an empty one — and an empty rota means NOT available, on purpose.
 * The result was an employee layer that shipped, worked, and was permanently
 * off-shift: the agent would not promise a specialist and, once appointments
 * landed, could not offer a single slot.
 *
 * Validated before it is stored, and this is the part that matters. `jsonb`
 * accepts any shape at all, so `{"Monday": [...]}` or `{"mon": [{"from":
 * "9am"}]}` would save cleanly and read back as a rota matching no window,
 * ever — the person silently unbookable with nothing to see. Errors name the
 * day and the window so whoever typed it can fix it.
 *
 * Not operator-only. Someone changing their own working hours is the most
 * ordinary thing on this screen, and `requireTenantScope` has already pinned the
 * :slug to the caller's business. The employee-belongs-to-this-org check below
 * is what stops one business editing another's rota.
 */
employeesRoute.patch("/:slug/employees/:employeeId/schedule", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const employee = await findEmployeeById(c.req.param("employeeId"));
  if (!employee || employee.organizationId !== organization.id) {
    // Same 404 for "no such employee" and "not yours" — telling one business
    // that an id exists elsewhere is an answer it has no reason to have.
    return c.json({ error: "Employee not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Nothing to change." }, 400);

  const working = "workingHours" in body ? parseWeeklySchedule(body.workingHours) : null;
  const breaks = "breakSchedule" in body ? parseWeeklySchedule(body.breakSchedule) : null;

  const errors = [...(working?.errors ?? []), ...(breaks?.errors ?? [])];
  if (errors.length > 0) {
    // 400 with every problem at once, not the first. An editor that reports one
    // bad window per save turns a five-day rota into five round trips.
    return c.json({ error: errors.join(" "), errors }, 400);
  }

  const updated = await updateEmployeeSchedule(employee.id, {
    workingHours: working?.schedule,
    breakSchedule: breaks?.schedule,
    timezone: typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : undefined,
  });
  if (!updated) return c.json({ error: "Employee not found" }, 404);

  const hours = weeklyHours(updated.workingHours);
  logger.info(
    { employeeId: updated.id, organization: organization.slug, weeklyHours: hours },
    hours === 0
      ? "Rota saved with no working hours — this employee is not bookable and will not be offered for escalation"
      : "Rota saved"
  );

  // `weeklyHours` and `presence` ride along so the screen can say what the rota
  // MEANS rather than only what it says. A saved rota totalling zero hours is
  // the exact state this endpoint exists to make visible, so it is reported
  // rather than left for someone to infer from an empty diary later.
  return c.json({
    employee: { ...updated, digitalSignature: undefined },
    weeklyHours: hours,
    presence: resolvePresence(updated),
  });
});

/**
 * Issue this employee a sign-in code.
 *
 * The code is generated server-side and returned exactly once, in this
 * response. It is never stored in readable form and cannot be fetched again —
 * a code the operator can look up later is a code sitting in a database waiting
 * for whoever gets that far. Lost it? Issue another; that invalidates the old
 * one in the same write.
 *
 * Operator-only. An employee who could mint credentials for their colleagues
 * could mint one for a colleague in another business, and the scope check would
 * dutifully honour it.
 */
/**
 * Calendar presence.
 *
 * ============================================================
 * THE URL IS A CREDENTIAL AND NEVER COMES BACK OUT
 * ============================================================
 *
 * A published ICS link is bearer access to somebody's diary: whoever holds it
 * reads every event title, attendee and location, with no sign-in and no way
 * for the owner to see who is reading. It goes in and is never serialised
 * again -- `CalendarRecord` carries the HOST and not the URL, which is enough
 * for a person to recognise which link they pasted.
 *
 * That is the same rule the operator alert webhook holds, and it is written
 * out here rather than assumed, because the natural shape of a settings screen
 * is to render the value back into the field it was typed in.
 */
employeesRoute.get("/:slug/calendars", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);
  return c.json({ calendars: await listCalendars(organization.id) });
});

employeesRoute.put("/:slug/employees/:employeeId/calendar", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const employee = await findEmployeeById(c.req.param("employeeId"));
  if (!employee || employee.organizationId !== organization.id) {
    return c.json({ error: "Employee not found" }, 404);
  }

  const body = (await c.req.json().catch(() => null)) as { icsUrl?: unknown } | null;
  const raw = typeof body?.icsUrl === "string" ? body.icsUrl.trim() : "";
  if (!raw) return c.json({ error: "Paste the secret iCal address of the calendar." }, 400);

  // webcal: is what Apple and Outlook put on the clipboard, and it is https
  // with a different scheme. Rewriting it here means somebody who pastes what
  // their calendar gave them is not told their link is wrong when it is not.
  const normalised = raw.replace(/^webcal:/i, "https:");

  // Checked before it is STORED, not at the first sync. A link that will never
  // work should be refused while the person who pasted it is still looking at
  // the screen, rather than becoming an error they discover a quarter of an
  // hour later on a page they have closed.
  try {
    await assertPublicUrl(normalised);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "That address cannot be used.";
    return c.json({ error: reason }, 400);
  }

  const scope = scopeOf(c);
  const calendar = await connectCalendar({
    organizationId: organization.id,
    employeeId: employee.id,
    icsUrl: normalised,
    createdBy: scope.sub,
  });
  if (!calendar) return c.json({ error: "The calendar could not be connected." }, 500);

  // The host, never the URL. See the comment above this route.
  logger.info(
    { organizationId: organization.id, employeeId: employee.id, host: calendar.host, sub: scope.sub },
    "A calendar was connected"
  );
  return c.json({ calendar });
});

employeesRoute.delete("/:slug/employees/:employeeId/calendar", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const removed = await disconnectCalendar(organization.id, c.req.param("employeeId"));
  if (!removed) return c.json({ error: "No calendar is connected for that person." }, 404);
  return c.json({ ok: true });
});

/**
 * The numbers on this business's WhatsApp account, and whose each one is.
 *
 * ============================================================
 * MULTIPLE WHATSAPP, THE ONLY WAY IT CAN WORK
 * ============================================================
 *
 * A staff member cannot connect their PERSONAL WhatsApp — the consumer app has
 * no API, and the tools that fake it drive a hidden web session that gets the
 * whole account banned. What IS possible is a DEDICATED number registered on the
 * company's WhatsApp Business Account, one per staff member, which Meta then
 * lets this platform send and receive on.
 *
 * So the owner does not "connect" anything here — they take a number that is
 * already on the account (asked of Meta live, so the list is fact, not a stale
 * row) and hand it to a person. The shared company number is shown but never
 * offered: giving it to one staff member would route the whole business's
 * traffic to them.
 */
employeesRoute.get("/:slug/whatsapp-numbers", async (c) => {
  const scope = c.get("scope");
  if (scope?.role !== "operator") {
    return c.json({ error: "Only the owner can see the account's numbers." }, 403);
  }

  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const [live, employees] = await Promise.all([
    listWabaNumbers(organization.whatsappBusinessAccountId).catch(() => []),
    listEmployees(organization.id),
  ]);

  const byNumber = new Map(
    employees
      .filter((e) => e.whatsappPhoneNumberId)
      .map((e) => [e.whatsappPhoneNumberId as string, { id: e.id, name: e.fullName }])
  );

  return c.json({
    numbers: live.map((n) => ({
      phoneNumberId: n.phoneNumberId,
      displayPhoneNumber: n.displayPhoneNumber,
      verifiedName: n.verifiedName,
      qualityRating: n.qualityRating,
      // The shared company line, which every business answers on. Not assignable.
      isShared: n.phoneNumberId === organization.whatsappPhoneNumberId,
      assignedTo: byNumber.get(n.phoneNumberId) ?? null,
    })),
  });
});

/**
 * Give a staff member one of the account's numbers, or take it back (null).
 *
 * Operator-only, and it refuses the shared number outright — that is the guard
 * that stops somebody accidentally routing the whole company's inbox to one
 * person. The number must be one Meta actually holds on this account, checked
 * against the live list rather than trusted from the request.
 */
employeesRoute.patch("/:slug/employees/:employeeId/whatsapp-number", async (c) => {
  const scope = c.get("scope");
  if (scope?.role !== "operator") {
    return c.json({ error: "Only the owner can assign a WhatsApp number." }, 403);
  }

  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const employee = await findEmployeeById(c.req.param("employeeId"));
  if (!employee || employee.organizationId !== organization.id) {
    return c.json({ error: "Employee not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const phoneNumberId =
    body && typeof body.phoneNumberId === "string" && body.phoneNumberId.trim()
      ? body.phoneNumberId.trim()
      : null;

  if (phoneNumberId) {
    if (phoneNumberId === organization.whatsappPhoneNumberId) {
      return c.json(
        { error: "That is the shared company number — assigning it would send every customer to one person." },
        422
      );
    }
    const live = await listWabaNumbers(organization.whatsappBusinessAccountId).catch(() => []);
    const match = live.find((n) => n.phoneNumberId === phoneNumberId);
    if (!match) {
      return c.json(
        { error: "That number is not on this WhatsApp account. Register it with Meta first." },
        422
      );
    }
    const updated = await assignEmployeeWhatsAppNumber(employee.id, {
      phoneNumberId,
      displayNumber: match.displayPhoneNumber,
      verifiedName: match.verifiedName,
    });
    logger.info(
      { employeeId: employee.id, organization: organization.slug, phoneNumberId },
      "Assigned a dedicated WhatsApp number to a staff member"
    );
    return c.json({ employee: { ...updated, digitalSignature: undefined } });
  }

  const updated = await assignEmployeeWhatsAppNumber(employee.id, {
    phoneNumberId: null,
    displayNumber: null,
    verifiedName: null,
  });
  logger.info({ employeeId: employee.id, organization: organization.slug }, "Cleared a staff member's WhatsApp number");
  return c.json({ employee: { ...updated, digitalSignature: undefined } });
});

employeesRoute.post("/:slug/employees/:employeeId/access-code", async (c) => {
  const scope = c.get("scope");
  if (scope?.role !== "operator") {
    return c.json({ error: "Only the operator can issue access codes." }, 403);
  }

  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const employee = await findEmployeeById(c.req.param("employeeId"));
  if (!employee || employee.organizationId !== organization.id) {
    return c.json({ error: "Employee not found" }, 404);
  }
  if (!employee.isActive) {
    return c.json({ error: "That employee is no longer active." }, 400);
  }

  const accessCode = generateAccessCode();
  const stored = await setEmployeeAccessCodeHash(employee.id, hashAccessCode(accessCode));
  if (!stored) return c.json({ error: "Could not set an access code for that employee." }, 500);

  logger.info(
    { organizationSlug: organization.slug, employeeId: employee.id },
    "Access code issued for employee"
  );

  return c.json({
    accessCode,
    // What they sign in WITH, so the operator can pass on both halves in one go.
    signInAs: employee.email ?? employee.employeeCode,
    employee: { id: employee.id, fullName: employee.fullName },
  });
});

/**
 * Log a lead an employee got on their own WhatsApp.
 *
 * The point of the whole employee layer: follow-up happens on personal phones,
 * and until this existed none of it reached the pipeline. A deal won on an
 * employee's own number produced nothing the platform could see.
 *
 * Scored by the same rules engine as an inbound message so leads are comparable
 * however they arrived — the input is the employee's account of the enquiry
 * rather than the customer's own words, which is noisier, and still far better
 * than a lead nobody recorded.
 */
employeesRoute.post("/:slug/leads", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  const employeeId = typeof body.employeeId === "string" ? body.employeeId : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const rawNumber = typeof body.whatsappNumber === "string" ? body.whatsappNumber : "";

  if (!note) {
    return c.json({ error: "Add a note about what the customer wants — it is what gets scored." }, 400);
  }

  const contactWaId = normalizeWhatsAppNumber(rawNumber);
  if (!contactWaId) {
    return c.json(
      { error: "That WhatsApp number is not a valid international number — include the country code." },
      400
    );
  }

  const employee = await findEmployeeById(employeeId);
  if (!employee || !employee.isActive) {
    return c.json({ error: "employeeId must name an active employee" }, 400);
  }
  // An employee logs leads for their own business only. Without this, someone
  // could attribute a lead to another tenant's pipeline — and on a shared
  // number that is every other business on the platform.
  if (employee.organizationId !== organization.id) {
    return c.json({ error: "That employee belongs to a different business" }, 400);
  }

  const lead = await captureEmployeeLead({
    organizationId: organization.id,
    employeeId: employee.id,
    contactWaId,
    contactName: typeof body.contactName === "string" ? body.contactName : null,
    note,
  });

  logger.info(
    {
      organizationSlug: organization.slug,
      employeeId: employee.id,
      score: lead.score,
      priority: lead.priority,
      isNewContact: lead.isNewContact,
    },
    "Lead captured from an employee's own WhatsApp"
  );

  return c.json({ lead }, 201);
});

/** Leads brought in from personal phones — all of them, or one employee's. */
employeesRoute.get("/:slug/leads", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const employeeId = c.req.query("employeeId") || null;
  const leads = await listEmployeeLeads(organization.id, employeeId);

  // The labels already given, folded in here rather than fetched separately by
  // the screen: a list that renders unlabelled and then fills in a moment
  // later invites somebody to label the same lead twice.
  const labels = await labelsForAssessments(
    organization.id,
    leads.map((lead) => lead.assessmentId)
  );

  return c.json({
    leads: leads.map((lead) => ({ ...lead, label: labels.get(lead.assessmentId) ?? null })),
    accuracy: await leadScorerAccuracy(organization.id),
  });
});

/**
 * What a lead turned out to be.
 *
 * F3 has said "model second once labels exist" since this platform started,
 * and nothing in it ever produced a label -- so the condition was one nobody
 * could reach. This is the half that was missing.
 *
 * The question is binary on purpose. "What should the priority have been"
 * asks a person to do the scorer's job from memory, and the answers would be
 * noise. "Was this worth your time" is answerable in one click, months later,
 * by whoever handled it -- and is exactly what a model would train on.
 */
employeesRoute.put("/:slug/leads/:assessmentId/label", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    worthAttention?: unknown;
    outcome?: unknown;
    note?: unknown;
  } | null;
  if (typeof body?.worthAttention !== "boolean") {
    return c.json({ error: "Say whether this lead was worth someone's time." }, 400);
  }

  // An outcome this does not know is refused rather than stored as free text:
  // a column of near-synonyms is a column nothing can count.
  let outcome: string | null = null;
  if (body.outcome != null && body.outcome !== "") {
    if (!isLeadOutcome(body.outcome)) {
      return c.json({ error: `"${String(body.outcome)}" is not one of the outcomes on offer.` }, 400);
    }
    outcome = body.outcome;
  }

  const scope = scopeOf(c);
  const recorded = await recordLeadLabel({
    organizationId: organization.id,
    assessmentId: c.req.param("assessmentId"),
    worthAttention: body.worthAttention,
    outcome,
    note: typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null,
    // Always a person. This is training data for something that will later
    // decide which customers get attention.
    labelledBy: scope.sub,
  });

  // Same 404 for "no such assessment" and "not yours", so ids cannot be
  // enumerated across businesses.
  if (!recorded) return c.json({ error: "That lead is not available to mark." }, 404);
  return c.json({ accuracy: await leadScorerAccuracy(organization.id) });
});

/** Everything this employee is responsible for, with a ready-to-tap link each. */
employeesRoute.get("/:slug/employees/:employeeId/conversations", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const employee = await findEmployeeById(c.req.param("employeeId"));
  if (!employee || employee.organizationId !== organization.id) {
    return c.json({ error: "Employee not found" }, 404);
  }

  const conversations = await listConversationsForEmployee(employee.id);

  return c.json({
    conversations: conversations.map((conversation) => ({
      ...conversation,
      directContact: buildDirectContact({
        employee,
        businessName: conversation.businessName,
        customerWaId: conversation.contactWaId,
        customerName: conversation.contactName,
      }),
    })),
  });
});

// ============================================================
// Assignment and direct contact
// ============================================================

/**
 * Give a conversation to an employee (or hand it back with employeeId: null).
 *
 * Assignment alone changes who the AI twin speaks as — it does not silence the
 * AI. That is the point: an assigned conversation still gets answered out of
 * hours by that employee's twin, under their persona and their tenant's
 * governance. Silencing happens only when a human actually takes over, below.
 */
export const conversationAssignmentRoute = new Hono();

conversationAssignmentRoute.post("/:conversationId/assign", async (c) => {
  const conversationId = c.req.param("conversationId");
  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  const employeeId = typeof body.employeeId === "string" ? body.employeeId : null;

  if (employeeId) {
    const employee = await findEmployeeById(employeeId);
    if (!employee) return c.json({ error: "Employee not found" }, 404);
    if (!employee.isActive) return c.json({ error: "That employee is no longer active" }, 400);

    // The employee must belong to the business actually serving this
    // conversation. On a shared number the conversation is OWNED by the
    // number's owner but ROUTED elsewhere, so checking against
    // `organization_id` would let the retail team be assigned a legal enquiry
    // and answer it under the law firm's name.
    const serving = await resolveServingOrganizationId(conversationId, conversation.organizationId);
    if (employee.organizationId !== serving) {
      return c.json(
        { error: "That employee belongs to a different business than this conversation" },
        400
      );
    }
  }

  await assignConversationToEmployee(conversationId, employeeId);
  logger.info({ conversationId, employeeId }, "Conversation assignment changed");

  return c.json({ conversationId, employeeId });
});

/**
 * Hand this customer to an employee's personal WhatsApp.
 *
 * Returns the link, and — the part that matters — puts the conversation into
 * human handoff first. Without that the customer is being handled in two places
 * at once: the AI still replying on the platform number while a person messages
 * them from another, neither aware of the other. The link is the visible
 * feature; the pause is the reason this is a POST and not a URL the deck could
 * have assembled itself.
 */
conversationAssignmentRoute.post("/:conversationId/direct-contact", async (c) => {
  const conversationId = c.req.param("conversationId");
  const conversation = await findConversationById(conversationId);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    /* employeeId is optional — fall back to the assigned employee */
  }

  const employeeId =
    typeof body.employeeId === "string" ? body.employeeId : null;

  const employee = employeeId ? await findEmployeeById(employeeId) : null;
  if (!employee) {
    return c.json({ error: "employeeId is required and must name an active employee" }, 400);
  }

  const servingId = await resolveServingOrganizationId(conversationId, conversation.organizationId);
  const serving = await findOrganizationById(servingId);

  const directContact = buildDirectContact({
    employee,
    businessName: serving?.name ?? conversation.organizationSlug,
    customerWaId: conversation.contactWaId,
    customerName: null,
  });

  if (!directContact) {
    return c.json(
      { error: "This customer's WhatsApp id is not a number that can be opened in WhatsApp" },
      400
    );
  }

  // Stop the AI before handing over, not after. Doing it in the other order
  // leaves a window where the employee has already messaged the customer and
  // the twin answers the same person again on the platform number.
  await setConversationHandoff(conversationId, true, "taken_by_employee", employeeId);
  await pauseAiForContact(conversation.contactId);

  await publishInboxEvent({
    type: "handoff_changed",
    organizationId: conversation.organizationId,
    organizationSlug: conversation.organizationSlug,
    conversationId,
    isHumanHandoff: true,
  });

  logger.info(
    { conversationId, employeeId: employee.id, sendingAs: directContact.sendingAs },
    "Conversation taken to an employee's own WhatsApp — AI paused"
  );

  // Built AFTER the handoff has committed, and never allowed to fail it. The
  // employee opening WhatsApp is the operation that matters; the brief is a
  // convenience on top. buildHandoverBrief swallows its own failures and
  // returns a stated reason, so there is nothing to catch here — but the
  // ordering is the point: a slow model must not delay the handoff's effects,
  // only the response that describes them.
  const brief = await buildHandoverBrief(conversationId);

  return c.json({
    ...directContact,
    employee: { id: employee.id, fullName: employee.fullName, jobTitle: employee.jobTitle },
    aiPaused: true,
    brief,
  });
});

/**
 * Which business is actually serving this conversation.
 *
 * `routed_organization_id` when the switchboard set one, otherwise the owner.
 * Read through the conversation lookup rather than duplicating the join.
 */
async function resolveServingOrganizationId(
  conversationId: string,
  ownerOrganizationId: string
): Promise<string> {
  try {
    const routing = await getConversationRouting(conversationId);
    return routing?.routedOrganizationId ?? ownerOrganizationId;
  } catch (err) {
    logger.error({ conversationId, err }, "Routing lookup failed — falling back to the owning business");
    return ownerOrganizationId;
  }
}
