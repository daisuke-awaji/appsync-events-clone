import { unsubscribeMessageSchema } from "@appsync-events-clone/core";
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";

import { buildApigwClient, ddb } from "./shared/clients.js";
import { getEnv } from "./shared/env.js";
import { logger } from "./shared/logger.js";
import { postToConnection } from "./shared/post.js";

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const env = getEnv();
  const { connectionId, domainName, stage } = event.requestContext;
  const apigw = buildApigwClient(domainName, stage);

  let parsed;
  try {
    parsed = unsubscribeMessageSchema.parse(JSON.parse(event.body ?? "{}"));
  } catch (err) {
    await postToConnection(apigw, connectionId, {
      action: "error",
      message: "invalid unsubscribe message",
      detail: (err as Error).message,
    });
    return { statusCode: 400 };
  }

  // Use the byConnection GSI to find the subscription's primary key,
  // then delete from the base table.
  const res = await ddb.send(
    new QueryCommand({
      TableName: env.SUBSCRIPTIONS_TABLE,
      IndexName: "byConnection",
      KeyConditionExpression: "connectionId = :c AND subscriptionId = :s",
      ExpressionAttributeValues: {
        ":c": connectionId,
        ":s": parsed.id,
      },
    }),
  );

  for (const item of res.Items ?? []) {
    await ddb.send(
      new DeleteCommand({
        TableName: env.SUBSCRIPTIONS_TABLE,
        Key: { channelPrefix: item.channelPrefix as string, sk: item.sk as string },
      }),
    );
  }

  await postToConnection(apigw, connectionId, {
    action: "unsubscribe_success",
    id: parsed.id,
  });

  logger.info("unsubscribe", {
    connectionId,
    subscriptionId: parsed.id,
    removed: res.Items?.length ?? 0,
  });
  return { statusCode: 200 };
};
