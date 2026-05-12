import {
  candidatePrefixes,
  matchesPattern,
  parsePublishChannel,
  parseSubscribePattern,
  type ParsedChannel,
} from "@appsync-events-clone/core";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import { ddb } from "./clients.js";
import { getEnv } from "./env.js";

export interface SubscriptionRow {
  readonly channelPrefix: string;
  readonly sk: string;
  readonly connectionId: string;
  readonly subscriptionId: string;
  readonly pattern: string;
  readonly namespace: string;
}

export interface MatchedSubscriber {
  readonly connectionId: string;
  readonly subscriptionId: string;
  readonly pattern: string;
}

/**
 * Find all subscriptions that match the given concrete channel.
 *
 * Strategy: enumerate the candidate `channelPrefix` values for the concrete
 * channel and run a parallel DynamoDB Query for each. Any subscription that
 * could match must be stored under one of these prefixes (this invariant is
 * verified by a fast-check property test in @appsync-events-clone/core).
 */
export async function findMatchingSubscribers(
  concrete: ParsedChannel,
): Promise<MatchedSubscriber[]> {
  const prefixes = candidatePrefixes(concrete);

  const results = await Promise.all(
    prefixes.map(async (prefix) => {
      const items: SubscriptionRow[] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const res = await ddb.send(
          new QueryCommand({
            TableName: getEnv().SUBSCRIPTIONS_TABLE,
            KeyConditionExpression: "channelPrefix = :p",
            ExpressionAttributeValues: { ":p": prefix },
            ExclusiveStartKey: lastKey,
          }),
        );
        for (const it of res.Items ?? []) {
          items.push(it as unknown as SubscriptionRow);
        }
        lastKey = res.LastEvaluatedKey;
      } while (lastKey);
      return items;
    }),
  );

  // De-duplicate by (connectionId, subscriptionId) — a subscription pattern is
  // stored once but the same connection may match via several subscriptions.
  const seen = new Set<string>();
  const matched: MatchedSubscriber[] = [];
  for (const rows of results) {
    for (const row of rows) {
      try {
        const pattern = parseSubscribePattern(row.pattern);
        if (!matchesPattern(pattern, concrete)) continue;
      } catch {
        // Skip rows with corrupted patterns.
        continue;
      }
      const key = `${row.connectionId}#${row.subscriptionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matched.push({
        connectionId: row.connectionId,
        subscriptionId: row.subscriptionId,
        pattern: row.pattern,
      });
    }
  }
  return matched;
}

export function parseConcrete(channel: string): ParsedChannel {
  return parsePublishChannel(channel);
}
