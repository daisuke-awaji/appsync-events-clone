import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from "aws-lambda";

import { logger } from "./shared/logger.js";

export interface AuthContext extends Record<string, string> {
  readonly userId: string;
  readonly authMode: "apiKey";
}

type RequestEvent = APIGatewayRequestAuthorizerEventV2 & {
  readonly methodArn?: string;
  readonly queryStringParameters?: Record<string, string | undefined> | null;
  readonly headers?: Record<string, string | undefined> | null;
};

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-1" });

let cachedKey: string | undefined;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getApiKey(): Promise<string | undefined> {
  const arn = process.env.API_KEY_SECRET_ARN;
  if (!arn) {
    // Fallback for local/test: direct env var
    return process.env.API_KEY;
  }
  if (cachedKey && Date.now() < cacheExpiresAt) return cachedKey;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  cachedKey = res.SecretString;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedKey;
}

export const handler = async (
  event: RequestEvent,
): Promise<APIGatewaySimpleAuthorizerWithContextResult<AuthContext>> => {
  const expected = await getApiKey();
  if (!expected) {
    logger.error("API key is not configured (neither API_KEY_SECRET_ARN nor API_KEY set)");
    return { isAuthorized: false, context: { userId: "", authMode: "apiKey" } };
  }

  const provided =
    event.queryStringParameters?.["api-key"] ??
    event.queryStringParameters?.authorization ??
    event.headers?.["x-api-key"] ??
    event.headers?.["X-Api-Key"];

  if (provided !== expected) {
    logger.warn("API key authorization failed");
    return { isAuthorized: false, context: { userId: "", authMode: "apiKey" } };
  }

  return {
    isAuthorized: true,
    context: { userId: "api-key-user", authMode: "apiKey" },
  };
};
