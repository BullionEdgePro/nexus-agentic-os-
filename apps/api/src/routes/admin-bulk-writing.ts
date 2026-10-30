import { Hono } from "hono";
import { findOrganizationBySlug, getBusinessVoice } from "@nexus/db";
import { actorOf } from "../lib/actor.js";
import {
  rewriteDraft,
  takeWriterTurn,
  writeDrafts,
  type RewriteChange,
  type WriterBrief,
  type WriterKind,
} from "../lib/message-writer.js";

/**
 * Bulk messaging's AI writer, for the admins (30 Oct 2026).
 *
 * Two calls: three drafts from a brief, and one change to the message already
 * in the editor. Both write in the business's own voice (its name, tagline and
 * summary) and both only suggest — nothing here sends. The hourly limit is
 * taken before the model is asked, so a stuck button costs nothing after 30.
 *
 * Mounted under /api/bulk, behind operatorOnly like the rest of bulk messaging.
 */
export const adminBulkWritingRoute = new Hono();

const AI_AWAY = "The AI is not available right now — write the message yourself.";
const OVER_LIMIT = "That is 30 AI drafts this hour — wait a little, or write it yourself.";
const KINDS: readonly WriterKind[] = ["quick", "approved"];
const CHANGES: readonly RewriteChange[] = ["shorter", "formal", "arabic", "fix"];

/** The business and the voice to write in, or why not. */
async function voiceFor(slug: string) {
  const organization = await findOrganizationBySlug(slug);
  if (!organization) return null;
  return (await getBusinessVoice(organization.id)) ?? { name: organization.name, tagline: null, summary: null };
}

adminBulkWritingRoute.post("/:slug/write", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const kind = KINDS.find((k) => k === body?.kind);
  if (!kind) return c.json({ error: "Say whether this is a quick message or an approved one." }, 400);
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  if (!brief) return c.json({ error: "Say what the message is about." }, 400);
  if (brief.length > 500) return c.json({ error: "Keep the brief under 500 characters." }, 400);

  const voice = await voiceFor(c.req.param("slug"));
  if (!voice) return c.json({ error: "Business not found." }, 404);
  const actor = await actorOf(c);
  if (!takeWriterTurn(actor.id ?? "admin")) return c.json({ error: OVER_LIMIT }, 429);

  const request: WriterBrief = {
    kind,
    brief,
    tone: body.tone === "professional" ? "professional" : "friendly",
    length: body.length === "detailed" ? "detailed" : "short",
    language: body.language === "ar" ? "ar" : "en",
  };
  const drafts = await writeDrafts(request, voice);
  if (!drafts) return c.json({ error: AI_AWAY }, 503);
  return c.json({ drafts });
});

adminBulkWritingRoute.post("/:slug/rewrite", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const kind = KINDS.find((k) => k === body?.kind);
  if (!kind) return c.json({ error: "Say whether this is a quick message or an approved one." }, 400);
  const change = CHANGES.find((ch) => ch === body?.change);
  if (!change) return c.json({ error: "Choose how to change the message." }, 400);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "Nothing to rewrite." }, 400);
  if (text.length > 4096) return c.json({ error: "Keep the message under 4,096 characters." }, 400);
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : undefined;

  const voice = await voiceFor(c.req.param("slug"));
  if (!voice) return c.json({ error: "Business not found." }, 404);
  const actor = await actorOf(c);
  if (!takeWriterTurn(actor.id ?? "admin")) return c.json({ error: OVER_LIMIT }, 429);

  const rewritten = await rewriteDraft(kind, text, change, voice, reason);
  if (!rewritten) return c.json({ error: AI_AWAY }, 503);
  return c.json({ text: rewritten });
});
