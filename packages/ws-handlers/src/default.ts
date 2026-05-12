import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";

import { buildApigwClient } from "./shared/clients.js";
import { logger } from "./shared/logger.js";
import { postToConnection } from "./shared/post.js";

/**
 * Catch-all handler for messages whose `action` does not match any defined route.
 * The `$default` route is invoked when:
 *   - The body is non-JSON, or
 *   - The `action` field is missing, or
 *   - No route key matches.
 *
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-overview.html
 */
export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const { connectionId, domainName, stage } = event.requestContext;
  const apigw = buildApigwClient(domainName, stage);

  await postToConnection(apigw, connectionId, {
    action: "error",
    message: "Unknown action. Send a JSON message with a valid `action` field.",
  });

  logger.warn("default route hit", { connectionId, body: event.body?.slice(0, 200) });
  return { statusCode: 400 };
};
