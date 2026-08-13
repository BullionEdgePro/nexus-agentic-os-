import Anthropic from "@anthropic-ai/sdk";
// Still Google, and only here. Embeddings are the one call Anthropic cannot
// serve, so this file now pings two vendors — which is the new architecture
// stated in code rather than in a comment somewhere else.
import { GoogleGenAI } from "@google/genai";
import { getPool, withAllTenants } from "@nexus/db";
import { EMBEDDING_MODEL } from "@nexus/knowledge";

export interface ModelPreflightResult {
  model: string;
  tenants: string[];
  ok: boolean;
  error?: string;
}

/**
 * Boot-time check that every model configured in agent_configs can actually be
 * called with the current API key.
 *
 * This exists because of a real incident: `gemini-2.5-flash` is listed by the
 * models.list endpoint and documented as free-tier, but returns 404 "no longer
 * available to new users" for keys created after its cutoff. The reply
 * pipeline caught that 404 like any other AI failure and sent the generic
 * fallback message, so every customer got "I'm looping in a specialist" and
 * the system looked healthy from the outside — same visible symptom as the
 * earlier Anthropic credit exhaustion, completely different cause.
 *
 * A misconfigured model is not a transient error, it is a deployment that
 * cannot work. Surfacing it once at startup turns a silent, customer-facing
 * degradation into a loud line in the logs the moment it is introduced.
 *
 * Deliberately non-fatal: the worker still starts. A tenant whose model is
 * broken degrades to the fallback reply, which is bad but strictly better than
 * refusing to boot and taking down the other tenants with it.
 */
export async function preflightModels(): Promise<ModelPreflightResult[]> {
  // Genuinely cross-tenant: the whole question is "does every configured model
  // still exist", which has no per-tenant form. Declared rather than assumed —
  // the point of the context mechanism is that a query spanning every business
  // is something you write on purpose.
  const { rows } = await withAllTenants(
    "boot preflight: every tenant's configured model must be callable",
    () =>
      getPool().query<{ model: string; tenants: string[] }>(
        `select model, array_agg(o.slug order by o.slug) as tenants
         from agent_configs a
         join organizations o on o.id = a.organization_id
         where a.is_active = true
         group by model`
      )
  );
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // The embedding model is subject to exactly the same silent-retirement risk
  // as the chat models, and its failure is even quieter: retrieval just returns
  // nothing, so the agent answers ungrounded instead of visibly falling back.
  const embeddingCheck: Promise<ModelPreflightResult> = ai.models
    .embedContent({ model: EMBEDDING_MODEL, contents: ["ping"] })
    .then(() => ({ model: EMBEDDING_MODEL, tenants: ["<embeddings>"], ok: true }))
    .catch((err: unknown) => ({
      model: EMBEDDING_MODEL,
      tenants: ["<embeddings>"],
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));

  return Promise.all([
    embeddingCheck,
    ...rows.map(async ({ model, tenants }) => {
      try {
        // Smallest possible real call — a bad model name fails here the same
        // way it would on a customer's message, which is the point.
        // Smallest real call this vendor accepts. It costs a token and it is
        // the only thing that distinguishes "configured" from "callable" —
        // a key with no credit lists models happily and fails on use.
        //
        // This is also the earliest possible detection of the failure that
        // silently disabled the governance judge: an Anthropic key with a zero
        // balance answers every request with 400 "credit balance is too low",
        // and until this ran on the right vendor nothing said so at boot.
        await anthropic.messages.create({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        });
        return { model, tenants, ok: true };
      } catch (err) {
        return {
          model,
          tenants,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  ]);
}
