import { Hono } from "hono";
import {
  findEmployeeById,
  findOrganizationById,
  findAdminById,
  findAdminByEmail,
  updateAdminProfile,
  getPool,
} from "@nexus/db";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * Your own account.
 *
 * Nothing here reads or writes anybody else's row. Every query is keyed on the
 * employee id in the SESSION, never on one supplied by the caller — an endpoint
 * called "me" that accepts an id is an endpoint for editing colleagues.
 *
 * An operator has no employee record: they administer the platform rather than
 * work in one of its businesses. They get their email and role and nothing to
 * edit, which is honest — there is no operator profile to change.
 */
export const meRoute = new Hono();

function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

meRoute.get("/", async (c) => {
  const scope = scopeOf(c);

  if (scope.role === "operator") {
    // An operator DOES have a profile. This branch used to return fullName:
    // null and editable: false, which is why the panel showed the same email
    // twice — as the name and as the address — above the sentence "Operator
    // accounts have no profile to edit." The `admins` table has carried
    // full_name since accounts existed; the code simply never read it.
    //
    // Located by id from the session where there is one. The email fallback
    // covers a session minted by the old shared password, which carried no
    // adminId — those are retired now, but an unexpired one may still be in
    // somebody's browser.
    const admin = scope.adminId
      ? await findAdminById(scope.adminId)
      : await findAdminByEmail(scope.sub);

    return c.json({
      email: admin?.email ?? scope.sub,
      role: "operator" as const,
      fullName: admin?.fullName ?? null,
      businessName: null,
      businessSlug: null,
      // A contact number ON RECORD. Nothing routes to it — an operator takes
      // no handoffs, so unlike employees.whatsapp_number this is not read by
      // the direct-contact link. Stored because it was asked for, and labelled
      // in the UI for what it is rather than implying a behaviour.
      whatsappNumber: admin?.whatsappNumber ?? null,
      avatarUrl: admin?.avatarUrl ?? null,
      jobTitle: null,
      // WHEN YOU LAST SIGNED IN, AND FROM WHAT. Shown on your own record
      // because you are the only person who can say whether it was you -- a
      // shared or leaked access code looks exactly like ordinary use from every
      // other angle, and looks like an unfamiliar device from this one.
      lastLoginAt: admin?.lastLoginAt ?? null,
      lastLoginDevice: admin?.lastLoginDevice ?? null,
      editable: Boolean(admin),
    });
  }

  if (!scope.employeeId) {
    return c.json({ error: "Your account is not attached to a business." }, 403);
  }

  const employee = await findEmployeeById(scope.employeeId);
  if (!employee) {
    // The session is signed and valid but the row is gone — deactivated and
    // deleted, or a database restored from before they existed. Saying so beats
    // rendering an empty profile that looks like a loading state.
    logger.warn({ employeeId: scope.employeeId }, "Session references an employee that no longer exists");
    return c.json({ error: "This account no longer exists." }, 404);
  }

  const organization = await findOrganizationById(employee.organizationId);

  return c.json({
    email: employee.email ?? scope.sub,
    role: "employee" as const,
    // The caller's OWN id. Read from the session-derived employee, never from a
    // parameter. The inbox uses it to pick out the conversations that belong to
    // this person from the shared business list — a comparison it can only make
    // if it knows who it is. Not sensitive on its own (it is the reader's own
    // id), and it never widens what they can load: the list is still scoped to
    // their one business by the API, this only filters within it.
    employeeId: employee.id,
    fullName: employee.fullName,
    employeeCode: employee.employeeCode,
    businessName: organization?.name ?? null,
    businessSlug: organization?.slug ?? null,
    whatsappNumber: employee.whatsappNumber,
    avatarUrl: employee.avatarUrl,
    jobTitle: employee.jobTitle,
    editable: true,
  });
});

/**
 * Update your own profile.
 *
 * WHAT IS DELIBERATELY NOT EDITABLE HERE, because the omissions are the design:
 *
 *   email / employee_code — these are how you sign in. Letting the profile
 *     screen change them means one mistyped character locks somebody out of
 *     their own account with no way back, since there is no password reset
 *     flow on this platform. An operator reissues them.
 *
 *   digital_signature — a human-only attestation the AI twin must never
 *     reproduce (packages/employees/twin.ts). It does not belong on the same
 *     form as a display name.
 *
 *   permissions, is_active, organization — nobody grants themselves anything.
 */
meRoute.patch("/", async (c) => {
  const scope = scopeOf(c);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Nothing to change." }, 400);

  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : undefined;
  if (fullName !== undefined && !fullName) {
    return c.json({ error: "A name cannot be empty." }, 400);
  }

  // Stored as the customer would dial it. The direct-contact link is built from
  // this, and a number with spaces and brackets makes a wa.me URL that opens
  // WhatsApp on nothing.
  let whatsappNumber: string | null | undefined;
  if ("whatsappNumber" in body) {
    const raw = typeof body.whatsappNumber === "string" ? body.whatsappNumber.trim() : "";
    if (!raw) {
      whatsappNumber = null;
    } else {
      const digits = raw.replace(/\D/g, "");
      if (digits.length < 8 || digits.length > 15) {
        return c.json({ error: `"${raw}" is not a phone number a customer could dial.` }, 400);
      }
      whatsappNumber = digits;
    }
  }

  let avatarUrl: string | null | undefined;
  if ("avatarUrl" in body) {
    const raw = typeof body.avatarUrl === "string" ? body.avatarUrl.trim() : "";
    if (!raw) {
      avatarUrl = null;
    } else if (raw.startsWith("data:")) {
      // AN UPLOADED FILE ARRIVES AS A DATA URI.
      //
      // There is no object storage on this deployment, so the browser resizes
      // the picture to 256px and sends it inline. That is the honest way to
      // support "choose a file" without inventing a storage layer — and it is
      // why the format is pinned rather than trusted.
      //
      // The allow-list is three raster formats. SVG is REFUSED even though it
      // is an image: an SVG can carry <script>, and this lands in an <img src>
      // on a page other staff load. A picture that can execute is not a
      // picture.
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(raw);
      if (!match) {
        return c.json(
          { error: "That image format is not supported. Use a PNG, JPEG or WebP." },
          400
        );
      }
      // ~200KB of base64 is roughly 150KB of image, which is generous for a
      // 256px avatar and small enough to sit in a text column and be sent with
      // every profile read. A cap stated here beats one discovered when a row
      // stops fitting.
      if (raw.length > 200_000) {
        return c.json({ error: "That image is too large. Choose one under 150KB." }, 400);
      }
      avatarUrl = raw;
    } else {
      // A link. https only, and parsed rather than pattern-matched, so
      // "javascript:" is refused by the protocol check rather than by a regex
      // somebody has to get exactly right.
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return c.json({ error: "That does not look like a web address." }, 400);
      }
      if (parsed.protocol !== "https:") {
        return c.json({ error: "The image address must start with https://" }, 400);
      }
      avatarUrl = parsed.toString();
    }
  }

  // An operator edits the same two things an employee does, minus the WhatsApp
  // number they have no use for. Handled before the employee path rather than
  // refused, which is what this endpoint did — the refusal was the bug.
  if (scope.role === "operator") {
    const adminId = scope.adminId
      ? scope.adminId
      : (await findAdminByEmail(scope.sub))?.id ?? null;

    if (!adminId) {
      // A session with no admin behind it — one issued by the retired shared
      // password. There is no row to edit, and saying so beats writing to
      // whichever admin happens to share the address.
      return c.json(
        { error: "This session predates named admin accounts. Sign out and back in." },
        403
      );
    }

    const ok = await updateAdminProfile(adminId, {
      fullName: fullName || undefined,
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      ...(whatsappNumber !== undefined ? { whatsappNumber } : {}),
    });
    if (!ok) return c.json({ error: "This account is no longer active." }, 404);
    return c.json({ ok: true });
  }

  if (!scope.employeeId) {
    return c.json({ error: "Your account is not attached to a business." }, 403);
  }

  const { rows } = await getPool().query<{ id: string }>(
    `update employees
        set full_name       = coalesce($2, full_name),
            whatsapp_number = case when $3::boolean then $4 else whatsapp_number end,
            avatar_url      = case when $5::boolean then $6 else avatar_url end,
            updated_at      = now()
      where id = $1 and is_active = true
      returning id`,
    [
      scope.employeeId,
      fullName ?? null,
      whatsappNumber !== undefined,
      whatsappNumber ?? null,
      avatarUrl !== undefined,
      avatarUrl ?? null,
    ]
  );

  if (!rows[0]) return c.json({ error: "This account is no longer active." }, 404);
  return c.json({ ok: true });
});
