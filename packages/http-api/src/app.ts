import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";

import { apiKeyAuth } from "./middleware/auth.js";
import { publishRoutes } from "./routes/publish.js";

export function createApp(): Hono {
  const app = new Hono();
  app.use("*", honoLogger());
  app.get("/health", (c) => c.json({ ok: true }));
  app.use("/event", apiKeyAuth);
  app.route("/", publishRoutes);
  return app;
}
