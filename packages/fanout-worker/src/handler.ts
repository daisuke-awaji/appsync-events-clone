import { GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import pLimit from "p-limit";
import { z } from "zod";

import { apigw, ddb } from "./clients.js";
import { getEnv } from "./env.js";
import { findMatchingSubscribers, parseConcrete } from "./matcher.js";

const fanoutMessageSchema = z.object({
  channel: z.string(),
  namespace: z.string(),
  events: z.array(z.string()),
  publishedAt: z.number().optional(),
  publisherConnectionId: z.string().optional(),
});

type FanoutMessage = z.infer<typeof fanoutMessageSchema>;

const encoder = new TextEncoder();

async function deliverOne(
  connectionId: string,
  subscriptionId: string,
  msg: FanoutMessage,
): Promise<void> {
  // Send each event individually as a `data` frame, mirroring the AppSync
  // Events realtime protocol.
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
        await ddb.send(
          new DeleteCommand({
            TableName: getEnv().CONNECTIONS_TABLE,
            Key: { connectionId },
          }),
        );
        return; // stop sending further events to a closed connection
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
 * SQS-driven fanout worker.
 *
 * Reports per-record failures via SQS partial batch response so that successful
 * records are not redelivered.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.all(
    event.Records.map(async (record) => {
      try {
        await processRecord(record);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: "error",
            msg: "fanout record failed",
            messageId: record.messageId,
            error: (err as Error).message,
          }),
        );
        failures.push({ itemIdentifier: record.messageId });
      }
    }),
  );

  return { batchItemFailures: failures };
};
