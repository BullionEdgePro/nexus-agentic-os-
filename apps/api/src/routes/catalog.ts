import { Hono } from "hono";
import {
  listCatalogItems,
  listCatalogInstalls,
  countCatalog,
  installCatalogItem,
  removeCatalogInstall,
  findCatalogInstall,
  findOrganizationBySlug,
} from "@nexus/db";
import { activateInstall, takeInstallUpdate } from "../services/catalog-activation.js";
import { logger } from "../lib/logger.js";

/**
 * The marketplace (F13) — browse the catalogue, install into a business.
 *
 * MOUNTED AT /api/catalog AND OPERATOR-ONLY, which are two decisions worth
 * separating.
 *
 * Why not under /api/organizations/:slug, where Knowledge and Procedures live.
 * Those are one business's own material and the mount gives them a tenant
 * context for free. The catalogue is the opposite: one shelf for the whole
 * platform, holding nobody's data, and the interesting view of it is "who is
 * running what" across all five businesses at once. There is no per-business
 * form of that question, which is the same argument /api/links carries.
 *
 * Why operator-only. Installing a pack changes what every customer of that
 * business is eventually told. That is an owner's decision, not a sales
 * executive's — so unlike Knowledge and Procedures, which the people doing the
 * job are trusted with, this one is refused to employees outright by the
 * `operatorOnly` middleware in index.ts.
 *
 * WHAT FOLLOWS FROM THE CROSS-TENANT MOUNT, and it is the thing to be careful
 * about here. Every request runs under `withAllTenants`, so RLS on
 * `catalog_installs` is not narrowing anything: the organization_id passed into
 * each db call IS the boundary. That is why the handlers below resolve a
 * business from an explicit slug and pass its id down, and why nothing here
 * takes an install id without an organization to check it against. This is the
 * same shape as /api/tasks and /api/operators and carries the same warning.
 *
 * WHAT THIS ROUTE CANNOT DO, BY CONSTRUCTION: publish. There is no POST that
 * writes a `catalog_items` row, there is no db function that would, and
 * migration 039 revoked insert on that table from the application role. The
 * egress policy — nothing leaves — is not enforced here; it is enforced by
 * `catalog_items` having no column in which a business's material could be
 * recorded. This route simply has nothing to add to that.
 */
export const catalogRoute = new Hono();

/**
 * The shelf, what is installed, and the totals — in one response.
 *
 * Three requests would mean three loading states for one screen, and the page
 * cannot render an item honestly without knowing whether it is already
 * installed somewhere. Same reasoning as procedures shipping `readiness`
 * alongside the list.
 */
catalogRoute.get("/", async (c) => {
  const [items, installs, counts] = await Promise.all([
    listCatalogItems(),
    listCatalogInstalls(),
    countCatalog(),
  ]);

  return c.json({
    items,
    installs,
    counts,
    /**
     * Which kinds can actually be activated, stated in the payload rather than
     * hardcoded in the page.
     *
     * All three, now that 045 has given authored wording a home. A template
     * becomes an `agent_phrases` row rather than a `message_templates` row —
     * that table mirrors Meta and always was the wrong place.
     *
     * Still served from here rather than hardcoded in the page: which kinds
     * work is the server's answer, and two lists in two applications is how the
     * nav rail and the operator-only guard drifted apart once already.
     */
    activatableKinds: ["procedure", "template", "knowledge_pack"],
  });
});

catalogRoute.post("/installs", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const organizationSlug = typeof body.organizationSlug === "string" ? body.organizationSlug : "";
  const itemSlug = typeof body.itemSlug === "string" ? body.itemSlug : "";
  if (!organizationSlug || !itemSlug) {
    return c.json({ error: "Say which business and which item." }, 400);
  }

  const organization = await findOrganizationBySlug(organizationSlug);
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const result = await installCatalogItem(organization.id, itemSlug);
  if (!result.ok) {
    // 409 for "already installed", 400 for "not published". Different problems:
    // one is a state the caller can see on the page and the other is a request
    // that should never have been made, and collapsing them would make the
    // client guess which sentence to show.
    const status = result.refusal === "already-installed" ? 409 : 400;
    logger.info(
      { business: organization.slug, itemSlug, refusal: result.refusal },
      "Catalogue install refused"
    );
    return c.json({ error: result.message }, status);
  }

  logger.info(
    { business: organization.slug, itemSlug, version: result.install.installedVersion },
    "Catalogue item installed"
  );
  return c.json({ install: result.install }, 201);
});

/**
 * Activate — put this pack's material into the business.
 *
 * A procedure lands in "How we answer" SWITCHED OFF and a person turns it on
 * there. That is not a limitation of this endpoint; it is the design. The
 * review screen already shows what else is active for the same situation and
 * already refuses two at once, and a catalogue button that reached past it into
 * the live prompt would be the single thing 039 was written to prevent.
 *
 * There is deliberately NO deactivate here, and the omission is the considered
 * half. Once a pack's material is in the business it IS the business's — the
 * procedure may have been switched on and be shaping replies, the knowledge may
 * have been edited since it arrived. Taking it back out from this screen would
 * reach across into two surfaces that own those decisions and can show what
 * else depends on them. "How we answer" turns a procedure off; "Knowledge"
 * deletes a source. Both already exist, both are where a person can see the
 * consequences, and neither needed rebuilding here.
 *
 * Removing the INSTALL is a different thing again and leaves the material in
 * place, which the page says out loud rather than letting somebody assume that
 * un-installing tidies up after itself.
 */
catalogRoute.post("/installs/:id/activate", async (c) => {
  const organizationSlug = c.req.query("business") ?? "";
  if (!organizationSlug) return c.json({ error: "Say which business." }, 400);

  const organization = await findOrganizationBySlug(organizationSlug);
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const install = await findCatalogInstall(organization.id, c.req.param("id"));
  if (!install) {
    return c.json({ error: "That business has no live install with that id." }, 404);
  }

  const outcome = await activateInstall(organization.id, install);
  if (!outcome.ok) {
    // 501 for the two structural refusals — they are not the caller's mistake
    // and no retry or different input will help. 503 for the embedding outage,
    // which is temporary and worth trying again. 400 for a payload nobody can
    // use. Collapsing these would make "try again later" indistinguishable from
    // "this will never work", which is the difference the operator needs.
    const status =
      outcome.refusal === "guidance-only"
        ? 501
        : outcome.refusal === "embedding-unavailable"
          ? 503
          : 400;
    logger.info(
      { business: organization.slug, item: install.itemSlug, refusal: outcome.refusal },
      "Catalogue activation refused"
    );
    return c.json({ error: outcome.message, refusal: outcome.refusal }, status);
  }

  return c.json({ outcome });
});

/**
 * Take the newer version of a pack this business already has.
 *
 * Only ever from a button. 039's rule is that "an installed business keeps what
 * it installed until it CHOOSES to take an update", so there is deliberately no
 * sweep, no auto-upgrade, and nothing on a schedule that could reach this.
 */
catalogRoute.post("/installs/:id/update", async (c) => {
  const organizationSlug = c.req.query("business") ?? "";
  if (!organizationSlug) return c.json({ error: "Say which business." }, 400);

  const organization = await findOrganizationBySlug(organizationSlug);
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const install = await findCatalogInstall(organization.id, c.req.param("id"));
  if (!install) {
    return c.json({ error: "That business has no live install with that id." }, 404);
  }

  const outcome = await takeInstallUpdate(organization.id, install);
  if (!outcome.ok) {
    // 409 for the two states the caller can see and resolve — somebody rewrote
    // it, or the wording is live and wants switching off first. 503 for an
    // embedding outage, which is worth retrying. 400 for a payload nobody can
    // use, and for "already current", which is a stale page rather than a fault.
    const status =
      outcome.refusal === "rewritten-here" || outcome.refusal === "wording-is-live"
        ? 409
        : outcome.refusal === "embedding-unavailable"
          ? 503
          : 400;
    logger.info(
      { business: organization.slug, item: install.itemSlug, refusal: outcome.refusal },
      "Catalogue update refused"
    );
    return c.json({ error: outcome.message, refusal: outcome.refusal }, status);
  }

  return c.json({ outcome });
});

/**
 * Take one back out.
 *
 * The business is named in the body rather than inferred from the install id,
 * so the id is checked against an organization the caller has stated. Under the
 * cross-tenant context this route runs in, an id on its own would be enough to
 * remove any business's install — see the note at the top of this file.
 */
catalogRoute.delete("/installs/:id", async (c) => {
  const organizationSlug = c.req.query("business") ?? "";
  if (!organizationSlug) return c.json({ error: "Say which business." }, 400);

  const organization = await findOrganizationBySlug(organizationSlug);
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const removed = await removeCatalogInstall(organization.id, c.req.param("id"));
  if (!removed) {
    return c.json({ error: "That business has no live install with that id." }, 404);
  }

  logger.info(
    { business: organization.slug, itemSlug: removed.itemSlug },
    "Catalogue item removed"
  );
  return c.json({ install: removed });
});
