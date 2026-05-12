import { BatchWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

type WriteRequest = Record<string, unknown>;

const MAX_BATCH_SIZE = 25;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 50;

/**
 * BatchWrite with automatic chunking and exponential-backoff retry for
 * UnprocessedItems.
 *
 * DynamoDB BatchWriteItem may return unprocessed items under provisioned
 * throughput pressure. This helper retries them with jittered back-off.
 */
export async function batchWriteWithRetry(
  client: DynamoDBDocumentClient,
  tableName: string,
  requests: WriteRequest[],
): Promise<void> {
  for (let i = 0; i < requests.length; i += MAX_BATCH_SIZE) {
    let pending: WriteRequest[] = requests.slice(i, i + MAX_BATCH_SIZE);
    let attempt = 0;

    while (pending.length > 0) {
      const res = await client.send(
        new BatchWriteCommand({
          RequestItems: { [tableName]: pending },
        }),
      );
      const unprocessed = res.UnprocessedItems?.[tableName] as WriteRequest[] | undefined;
      if (!unprocessed || unprocessed.length === 0) break;

      attempt++;
      if (attempt >= MAX_RETRIES) {
        throw new Error(
          `batchWriteWithRetry: ${unprocessed.length} items still unprocessed after ${MAX_RETRIES} retries`,
        );
      }
      const delay = BASE_DELAY_MS * 2 ** attempt + Math.random() * BASE_DELAY_MS;
      await new Promise((r) => setTimeout(r, delay));
      pending = unprocessed;
    }
  }
}
