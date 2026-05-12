import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from "aws-lambda";

import { logger } from "./shared/logger.js";

/**
 * Lambda Authorizer for the WebSocket `$connect` route.
 *
 * MVP authorization: simple API key check. The expected key is provided via
 * the `API_KEY` environment variable. The client sends the key as either:
 *   - a query string parameter `?api-key=...` (browsers cannot set custom
 *     headers on WebSocket upgrade), or
 *   - the `x-api-key` header (server-side clients).
 *
 * On success the authorizer returns `isAuthorized: true` plus a `context`
 * payload which is later available to other Lambdas through
 * `event.requestContext.authorizer.lambda.*`.
 *
 * NOTE: API Gateway WebSocket APIs only run authorizers on `$connect`.
 *   https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-lambda-auth.html
 */
export interface AuthContext extends Record<string, string> {
  readonly userId: string;
  readonly authMode: "apiKey";
}

type RequestEvent = APIGatewayRequestAuthorizerEventV2 & {
  readonly methodArn?: string;
  readonly queryStringParameters?: Record<string, string | undefined> | null;
  readonly headers?: Record<string, string | undefined> | null;
};

export const handler = (
  event: RequestEvent,
): APIGatewaySimpleAuthorizerWithContextResult<AuthContext> => {
  const expected = process.env.API_KEY;
  if (!expected) {
    logger.error("API_KEY env var is not configured");
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

  // For MVP we tag the user with a static identifier. This will later be
  // replaced by Cognito sub or similar.
  return {
    isAuthorized: true,
    context: { userId: "api-key-user", authMode: "apiKey" },
  };
};
