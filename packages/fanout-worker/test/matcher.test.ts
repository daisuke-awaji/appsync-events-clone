import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { parseConcrete } from "../src/matcher.js";
import { findMatchingSubscribers } from "../src/matcher.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("findMatchingSubscribers", () => {
  beforeEach(() => ddbMock.reset());

  it("returns subscribers whose pattern matches the concrete channel", async () => {
    // candidate prefixes for /default/room/123: ["/default", "/default/room", "/default/room/123"]
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ":p": "/default" },
      })
      .resolves({
        Items: [
          {
            channelPrefix: "/default",
            sk: "c1#s1",
            connectionId: "c1",
            subscriptionId: "s1",
            pattern: "/default/**",
            namespace: "default",
          },
        ],
      });
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ":p": "/default/room" },
      })
      .resolves({
        Items: [
          {
            channelPrefix: "/default/room",
            sk: "c2#s2",
            connectionId: "c2",
            subscriptionId: "s2",
            pattern: "/default/room/*",
            namespace: "default",
          },
          {
            channelPrefix: "/default/room",
            sk: "c3#s3",
            connectionId: "c3",
            subscriptionId: "s3",
            pattern: "/default/room/other",
            namespace: "default",
          },
        ],
      });
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ":p": "/default/room/123" },
      })
      .resolves({
        Items: [
          {
            channelPrefix: "/default/room/123",
            sk: "c4#s4",
            connectionId: "c4",
            subscriptionId: "s4",
            pattern: "/default/room/123",
            namespace: "default",
          },
        ],
      });

    const result = await findMatchingSubscribers(parseConcrete("/default/room/123"));
    const ids = result.map((r) => r.connectionId).sort();
    expect(ids).toEqual(["c1", "c2", "c4"]);
  });

  it("filters out non-matching patterns under the same prefix", async () => {
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ":p": "/default" },
      })
      .resolves({ Items: [] });
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ":p": "/default/room" },
      })
      .resolves({
        Items: [
          {
            channelPrefix: "/default/room",
            sk: "c1#s1",
            connectionId: "c1",
            subscriptionId: "s1",
            pattern: "/default/room/other/sub",
            namespace: "default",
          },
        ],
      });
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ":p": "/default/room/123" },
      })
      .resolves({ Items: [] });

    const result = await findMatchingSubscribers(parseConcrete("/default/room/123"));
    expect(result).toEqual([]);
  });

  it("deduplicates by (connectionId, subscriptionId)", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          channelPrefix: "/default/room",
          sk: "c1#s1",
          connectionId: "c1",
          subscriptionId: "s1",
          pattern: "/default/room/*",
          namespace: "default",
        },
      ],
    });

    const result = await findMatchingSubscribers(parseConcrete("/default/room/x"));
    expect(result).toHaveLength(1);
  });
});
