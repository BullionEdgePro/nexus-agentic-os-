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
} from "@nexus/db";
import {
  buildDirectContact,
  normalizeWhatsAppNumber,
  resolvePresence,
  generateAccessCode,
  hashAccessCode,
} from "@nexus/employees";
import { captureEmployeeLead, listEmployeeLeads } from "@nexus/leads";
import { publishInboxEvent } from "../lib/pubsub.js";
import { buildHandoverBrief } from "@nexus/agents";
import { logger } from "../lib/logger.js";

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
  return c.json({ leads });
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
  await setConversationHandoff(conversationId, true);
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
