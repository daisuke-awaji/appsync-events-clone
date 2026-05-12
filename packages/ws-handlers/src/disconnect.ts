import { BatchWriteCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";

import { ddb } from "./shared/clients.js";
import { getEnv } from "./shared/env.js";
import { logger } from "./shared/logger.js";

const BATCH_SIZE = 25;

async function deleteAllSubscriptions(connectionId: string): Promise<number> {
  const env = getEnv();
  let total = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: env.SUBSCRIPTIONS_TABLE,
        IndexName: "byConnection",
        KeyConditionExpression: "connectionId = :c",
        ExpressionAttributeValues: { ":c": connectionId },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    const items = res.Items ?? [];
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const chunk = items.slice(i, i + BATCH_SIZE);
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [env.SUBSCRIPTIONS_TABLE]: chunk.map((it) => ({
              DeleteRequest: {
                Key: { channelPrefix: it.channelPrefix as string, sk: it.sk as string },
              },
            })),
          },
        }),
      );
      total += chunk.length;
    }
    lastEvaluatedKey = res.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return total;
}

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const env = getEnv();
  const { connectionId } = event.requestContext;

  const removed = await deleteAllSubscriptions(connectionId);

  await ddb.send(
    new DeleteCommand({
      TableName: env.CONNECTIONS_TABLE,
      Key: { connectionId },
    }),
  );

  logger.info("disconnect", { connectionId, removedSubscriptions: removed });
  return { statusCode: 200 };
};
