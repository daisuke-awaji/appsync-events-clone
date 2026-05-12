import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2WithRequestContext,
  APIGatewayEventWebsocketRequestContextV2,
} from "aws-lambda";

import { ddb } from "./shared/clients.js";
import { getEnv } from "./shared/env.js";
import { logger } from "./shared/logger.js";

interface AuthorizerContext {
  readonly userId?: string;
  readonly authMode?: string;
}

type ConnectEvent = APIGatewayProxyWebsocketEventV2WithRequestContext<
  APIGatewayEventWebsocketRequestContextV2 & {
    readonly authorizer?: { readonly lambda?: AuthorizerContext };
  }
>;

export const handler = async (event: ConnectEvent): Promise<APIGatewayProxyResultV2> => {
  const env = getEnv();
  const { connectionId } = event.requestContext;
  const authz = event.requestContext.authorizer?.lambda ?? {};
  const now = Date.now();

  await ddb.send(
    new PutCommand({
      TableName: env.CONNECTIONS_TABLE,
      Item: {
        connectionId,
        userId: authz.userId ?? "anonymous",
        authMode: authz.authMode ?? "none",
        connectedAt: now,
        ttl: Math.floor(now / 1000) + env.CONNECTION_TTL_SECONDS,
      },
    }),
  );

  logger.info("connect", { connectionId, userId: authz.userId });
  return { statusCode: 200 };
};
