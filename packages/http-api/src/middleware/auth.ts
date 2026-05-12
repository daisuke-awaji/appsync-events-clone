import type { MiddlewareHandler } from "hono";

import { getEnv } from "../env.js";

/**
 * MVP API key middleware. Accepts the key via either:
 *   - `x-api-key: <key>` header
 *   - `Authorization: Bearer <key>` header
 */
export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  const expected = getEnv().API_KEY;
  const xKey = c.req.header("x-api-key");
  const authz = c.req.header("authorization");
  const bearer = authz?.startsWith("Bearer ") ? authz.slice("Bearer ".length) : undefined;
  const provided = xKey ?? bearer;

  if (provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("userId", "api-key-user");
  await next();
  return undefined;
};
