import { Hono } from "hono";
import { getOverviewMetrics } from "@nexus/db";

export const metricsRoute = new Hono();

// Aggregate snapshot for the command-deck overview.
metricsRoute.get("/overview", async (c) => {
  const metrics = await getOverviewMetrics();
  return c.json({ metrics });
});
