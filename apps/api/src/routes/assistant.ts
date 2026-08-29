import { Hono } from "hono";
import {
  findEmployeeById,
  findOrganizationById,
  findAdminById,
  listMyClients,
  withTenant,
} from "@nexus/db";
import {
  completeRich,
  helpSystemPrompt,
  describeUnsupported,
  decodedBytes,
  type HelpTurn,
  type Attachment,
} from "@nexus/agents";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * The built-in help assistant.
 *
 * ============================================================
 * WHY IT IS SEPARATE FROM EVERY OTHER AGENT HERE
 * ============================================================
 *
 * The customer agent answers questions about a BUSINESS, from that business's
 * knowledge, to a member of the public. This answers questions about the
 * PLATFORM, from a written description of it, to somebody signed in. They share
 * a model and nothing else — different audience, different source of truth, and
 * a different worst case.
 *
 * Its worst case is worth naming because it is quiet: describing a screen that
 * does not exist. Nobody complains about that. They look, fail to find it,
 * decide the product is broken, and stop asking. So the grounding is explicit,
 * the instruction to refuse is first in the list, and the assistant is given no
 * ability to act.
 *
 * ============================================================
 * SCOPE
 * ============================================================
 *
 * The live facts handed to the model are read with the caller's own scope and
 * nothing else. A staff member's assistant can say how many clients THEY have;
 * it is never given another business's anything, because it is never asked for
 * it. There is no path here that widens a tenant.
 */
export const assistantRoute = new Hono();

/** Questions per person per hour. */
const HOURLY_LIMIT = 40;

/**
 * The largest single file, decoded.
 *
 * Well under what the model accepts, and chosen for the request rather than for
 * the model: this arrives as base64 in a JSON body, which is a third larger
 * again, and a person waiting on a phone connection notices.
 */
const MAX_FILE_BYTES = 4_500_000;
const asked = new Map<string, { count: number; windowStartedAt: number }>();

/**
 * A ceiling, because this costs money per question and a chat box is the one
 * control a person can hold down.
 *
 * In memory on purpose: it is a courtesy limit, not a security boundary, and a
 * restart forgiving somebody their last few questions is the correct amount of
 * strictness for that. A table would imply a guarantee this does not make.
 */
function withinRate(key: string): boolean {
  const now = Date.now();
  const seen = asked.get(key);
  if (!seen || now - seen.windowStartedAt > 3_600_000) {
    asked.set(key, { count: 1, windowStartedAt: now });
    return true;
  }
  seen.count += 1;
  return seen.count <= HOURLY_LIMIT;
}

function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

assistantRoute.post("/", async (c) => {
  const scope = scopeOf(c);
  const body = await c.req.json().catch(() => ({}));

  const question = typeof body.question === "string" ? body.question.trim().slice(0, 800) : "";
  if (!question) return c.json({ error: "Ask a question." }, 400);

  if (!withinRate(scope.sub)) {
    return c.json(
      {
        error:
          "That is a lot of questions in one hour. Take a break and come back — or ask the owner, who is faster than I am at anything specific to your business.",
      },
      429
    );
  }

  // Only the last few turns, and only their text. A history the caller can
  // supply is a history the caller can forge, so nothing in it is trusted for
  // anything except continuity of wording — it never grants access.
  const history: HelpTurn[] = Array.isArray(body.history)
    ? body.history
        .slice(-6)
        .filter(
          (turn: unknown): turn is HelpTurn =>
            typeof turn === "object" &&
            turn !== null &&
            (( turn as HelpTurn).role === "user" || (turn as HelpTurn).role === "assistant") &&
            typeof (turn as HelpTurn).text === "string"
        )
        .map((turn: HelpTurn) => ({ role: turn.role, text: turn.text.slice(0, 800) }))
    : [];

  const context = await describeCaller(scope);

  // ---- what they attached ------------------------------------------
  //
  // Refused HERE, before any model call, for the two reasons a person can act
  // on: the file is a kind that cannot be read at all, or it is too big. Both
  // are cheaper and clearer to answer without a round trip, and a refusal that
  // arrives after a ten-second wait reads as a failure rather than an answer.
  const attachments: Attachment[] = [];
  const rawFiles = Array.isArray(body.attachments) ? body.attachments.slice(0, 4) : [];

  for (const raw of rawFiles) {
    const name = typeof raw?.name === "string" ? raw.name.slice(0, 120) : "that file";
    const mediaType = typeof raw?.mediaType === "string" ? raw.mediaType : "";
    const data = typeof raw?.data === "string" ? raw.data : "";
    if (!data) continue;

    const unsupported = describeUnsupported(mediaType, name);
    if (unsupported) return c.json({ error: unsupported }, 415);

    if (decodedBytes(data) > MAX_FILE_BYTES) {
      return c.json(
        {
          error: `${name} is larger than ${Math.round(MAX_FILE_BYTES / 1_000_000)} MB, which is more than I can take in one go. A screenshot of the part you are asking about is usually enough.`,
        },
        413
      );
    }

    attachments.push({ name, mediaType, data });
  }

  const result = await completeRich({
    system: helpSystemPrompt(context),
    history,
    question,
    attachments,
    maxTokens: 1400,
  });

  if (!result.ok) {
    // Each reason gets its own sentence. "Something went wrong" for a file that
    // is simply a scan sends somebody looking for a fault that does not exist.
    logger.warn({ sub: scope.sub, reason: result.reason }, "Assistant could not answer");

    if (result.reason === "unreadable-file" || result.reason === "bad-image") {
      return c.json({ error: result.detail }, 415);
    }
    if (result.reason === "too-large") {
      return c.json(
        { error: "That was too much to send at once. Try one file, or a smaller one." },
        413
      );
    }
    return c.json(
      {
        error:
          "I could not reach the assistant just now. Nothing is wrong with your account — try again in a moment.",
      },
      502
    );
  }

  logger.info(
    { sub: scope.sub, role: scope.role, chars: question.length, files: attachments.length },
    "Assistant answered"
  );
  return c.json({ answer: result.text });
});

/**
 * Who is asking, and a few true things about them.
 *
 * Read with the caller's own scope. Best-effort: a failure here costs the
 * assistant some context and must not cost the person an answer, because "how
 * do I add a client" needs no live data at all.
 */
async function describeCaller(scope: SessionScope) {
  const facts: string[] = [];

  if (scope.role === "operator") {
    const admin = scope.adminId ? await findAdminById(scope.adminId).catch(() => null) : null;
    return {
      role: "operator" as const,
      fullName: admin?.fullName ?? null,
      businessName: null,
      facts,
    };
  }

  if (!scope.employeeId || !scope.organizationId) {
    return { role: "employee" as const, fullName: null, businessName: null, facts };
  }

  try {
    const [employee, organization, clients] = await withTenant(scope.organizationId, async () => [
      await findEmployeeById(scope.employeeId as string),
      await findOrganizationById(scope.organizationId as string),
      await listMyClients(scope.organizationId as string, scope.employeeId as string, { limit: 500 }),
    ]);

    if (employee) {
      facts.push(`They have ${clients.length} client(s) in their own book.`);
      facts.push(
        employee.whatsappNumber
          ? `Their WhatsApp number IS on file, so customers can be handed to them.`
          : `They have NO WhatsApp number on file, so customers who come through their link cannot be handed to them. Tell them to set it on My clients → Your link.`
      );
      facts.push(
        employee.canBroadcast
          ? `Campaigns are switched ON for them.`
          : `Campaigns are switched OFF for them; only the owner can turn that back on.`
      );
    }

    return {
      role: "employee" as const,
      fullName: employee?.fullName ?? null,
      businessName: organization?.name ?? null,
      facts,
    };
  } catch (err) {
    logger.warn({ err, sub: scope.sub }, "Help assistant could not read the caller's context");
    return { role: "employee" as const, fullName: null, businessName: null, facts };
  }
}
