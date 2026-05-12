import type { ServerMessage } from "@appsync-events-clone/core";
import {
  type ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";

import { ddb } from "./clients.js";
import { getEnv } from "./env.js";

const encoder = new TextEncoder();

export interface PostResult {
  readonly delivered: boolean;
  readonly gone: boolean;
}

/**
 * Send a JSON-serializable server message to a WebSocket connection.
 *
 * On `GoneException` (HTTP 410) the connection row in the Connections table is
 * deleted, since the API Gateway side has already closed the connection.
 *
 * Source: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html
 */
export async function postToConnection(
  client: ApiGatewayManagementApiClient,
  connectionId: string,
  message: ServerMessage,
): Promise<PostResult> {
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: encoder.encode(JSON.stringify(message)),
      }),
    );
    return { delivered: true, gone: false };
  } catch (err) {
    if (err instanceof GoneException || (err as { name?: string }).name === "GoneException") {
      await ddb.send(
        new DeleteCommand({
          TableName: getEnv().CONNECTIONS_TABLE,
          Key: { connectionId },
        }),
      );
      return { delivered: false, gone: true };
    }
    throw err;
  }
}
