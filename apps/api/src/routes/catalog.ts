import { Hono } from "hono";
import {
  listCatalogItems,
  listCatalogInstalls,
  countCatalog,
  installCatalogItem,
  removeCatalogInstall,
  findOrganizationBySlug,
} from "@nexus/db";
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
     * Stated in the payload, not only in the UI copy.
     *
     * An install currently records a decision and nothing more: no catalogue
     * payload has been wired into the live agent yet, so activating one would
     * be a switch that changes nothing while claiming to change what customers
     * hear. That is precisely the plausible-normal-state failure this system
     * keeps producing, so the API says so and the page repeats it rather than
     * offering a control that lies.
     */
    activationWired: false,
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
