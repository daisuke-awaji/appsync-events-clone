import { type FanoutMessage, fanoutMessageSchema, logger } from "@appsync-events-clone/core";
import { GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import pLimit from "p-limit";

import { apigw, ddb } from "./clients.js";
import { getEnv } from "./env.js";
import { findMatchingSubscribers, parseConcrete } from "./matcher.js";

const encoder = new TextEncoder();

/**
 * On GoneException: delete the connection row and all its subscriptions so
 * future fanout cycles skip this connection entirely.
 */
async function cleanupGoneConnection(connectionId: string): Promise<void> {
  const env = getEnv();

  await ddb.send(
    new DeleteCommand({
      TableName: env.CONNECTIONS_TABLE,
      Key: { connectionId },
    }),
  );

  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: env.SUBSCRIPTIONS_TABLE,
        IndexName: "byConnection",
        KeyConditionExpression: "connectionId = :c",
        ExpressionAttributeValues: { ":c": connectionId },
        ExclusiveStartKey: lastKey,
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
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
}

async function deliverOne(
  connectionId: string,
  subscriptionId: string,
  msg: FanoutMessage,
): Promise<void> {
  for (const ev of msg.events) {
    try {
      await apigw.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: encoder.encode(
            JSON.stringify({
              action: "data",
              id: subscriptionId,
              channel: msg.channel,
              event: ev,
            }),
          ),
        }),
      );
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (err instanceof GoneException || name === "GoneException") {
        await cleanupGoneConnection(connectionId);
        return;
      }
      throw err;
    }
  }
}

async function processRecord(record: SQSRecord): Promise<void> {
  const env = getEnv();
  const msg = fanoutMessageSchema.parse(JSON.parse(record.body));
  const concrete = parseConcrete(msg.channel);
  const matched = await findMatchingSubscribers(concrete);

  if (matched.length === 0) return;

  const limit = pLimit(env.FANOUT_CONCURRENCY);
  await Promise.all(
    matched.map((s) => limit(() => deliverOne(s.connectionId, s.subscriptionId, msg))),
  );
}

/**
 * SQS-driven fanout worker. Reports per-record failures via partial batch
 * response so that successful records are not redelivered.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.all(
    event.Records.map(async (record) => {
      try {
        await processRecord(record);
      } catch (err) {
        logger.error("fanout record failed", {
          messageId: record.messageId,
          error: (err as Error).message,
        });
        failures.push({ itemIdentifier: record.messageId });
      }
    }),
  );

  return { batchItemFailures: failures };
};
