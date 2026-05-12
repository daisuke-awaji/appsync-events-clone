import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { MiddlewareHandler } from "hono";

import { getEnv } from "../env.js";

const sm = new SecretsManagerClient({ region: getEnv().AWS_REGION });

let cachedKey: string | undefined;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getApiKey(): Promise<string> {
  const env = getEnv();
  if (env.API_KEY) return env.API_KEY;
  if (!env.API_KEY_SECRET_ARN) throw new Error("Neither API_KEY nor API_KEY_SECRET_ARN configured");
  if (cachedKey && Date.now() < cacheExpiresAt) return cachedKey;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: env.API_KEY_SECRET_ARN }));
  cachedKey = res.SecretString!;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedKey;
}

/**
 * API key middleware. Accepts the key via:
 *   - `x-api-key: <key>` header
 *   - `Authorization: Bearer <key>` header
 */
export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  const expected = await getApiKey();
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
