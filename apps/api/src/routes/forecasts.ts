import { Hono } from "hono";
import {
  findOrganizationBySlug,
  getForecastStatus,
  getUpcomingForecasts,
  getForecastAccuracy,
  getRecentlyScored,
  scoreDueForecasts,
  produceForecasts,
} from "@nexus/db";
import { logger } from "../lib/logger.js";

/**
 * Predictive BI, per business (F11).
 *
 * MOUNTED UNDER /api/organizations/:slug ALONGSIDE KNOWLEDGE AND PROCEDURES,
 * which is the substantive decision here rather than a routing convenience —
 * the same call F10 made, for the same two reasons.
 *
 * First, `requireTenantScope` and the tenant-context middleware already apply,
 * so every query below runs inside `withTenant` for the named business and the
 * RLS policy on `forecasts` is doing real work. The alternative mount,
 * /api/quality/:slug next to the rest of the reporting, would have been the
 * tidier grouping and would have inherited `operatorOnly` for free — but
 * `agent_quality_daily` under it is protected by that route check alone, and
 * spreading that arrangement to a new table would spread a gap rather than a
 * pattern.
 *
 * Second, it is reachable by that business's own staff and not only by a
 * platform operator. A forecast of how many customers write in next Thursday is
 * the business's own operational information — the argument already made for
 * Knowledge, Procedures and the diary. It is not management information about
 * staff, which is what the three operator-only screens hold.
 */
export const forecastsRoute = new Hono();

forecastsRoute.get("/:slug/forecast", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const [status, upcoming, accuracy, recent] = await Promise.all([
    getForecastStatus(organization.id),
    getUpcomingForecasts(organization.id),
    getForecastAccuracy(organization.id),
    getRecentlyScored(organization.id),
  ]);

  return c.json({
    // Shipped with the forecasts rather than behind a second request, and named
    // first because for most businesses on this platform it is the whole
    // response. Four of five have no customers; their `upcoming` is empty and
    // will be for months. An empty list with no sentence attached reads as
    // broken, which is the mistake F5's `blockedBecause` exists to correct.
    status,
    upcoming,
    // How the claims we actually committed to have turned out. Empty until
    // enough days have closed — and empty is the honest state, not a gap to be
    // filled with the backtest figure wearing a different label.
    accuracy,
    recent,
  });
});

/**
 * Score and re-forecast this business now.
 *
 * The daily job is the real mechanism; this exists for the same reason
 * /api/quality/refresh and the manual procedure inference do. On the day the
 * feature ships nothing has run, and a screen whose only answer is "come back
 * tomorrow" cannot be judged by the person who has to judge it.
 *
 * WHAT THIS CANNOT DO, and the reason it is safe to expose: it cannot
 * manufacture a good score. `produceForecasts` only ever names days that have
 * not begun, `recordForecasts` refuses anything else in SQL, and the accuracy
 * read counts only rows made before their target day started. Pressing this
 * button a hundred times writes the same seven future days a hundred times and
 * moves no published number.
 */
forecastsRoute.post("/:slug/forecast/refresh", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  try {
    const scored = await scoreDueForecasts(organization.id);
    const produced = await produceForecasts(organization.id);
    logger.info({ business: organization.slug, scored, ...produced }, "Forecast refresh (manual)");
    // `blocked` travels back whole. "Looked at both metrics, wrote nothing,
    // here is why" is a result; a bare zero is indistinguishable from a failure.
    return c.json({ scored, ...produced });
  } catch (err) {
    logger.error({ business: organization.slug, err }, "Manual forecast refresh failed");
    return c.json({ error: "Could not recompute the forecast right now." }, 502);
  }
});
