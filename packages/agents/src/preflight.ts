import { GoogleGenAI } from "@google/genai";
import { getPool } from "@nexus/db";

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
  const { rows } = await getPool().query<{ model: string; tenants: string[] }>(
    `select model, array_agg(o.slug order by o.slug) as tenants
     from agent_configs a
     join organizations o on o.id = a.organization_id
     where a.is_active = true
     group by model`
  );
  if (rows.length === 0) return [];

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  return Promise.all(
    rows.map(async ({ model, tenants }) => {
      try {
        // Smallest possible real call — a bad model name fails here the same
        // way it would on a customer's message, which is the point.
        await ai.models.generateContent({
          model,
          contents: "ping",
          config: { maxOutputTokens: 1 },
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
    })
  );
}
