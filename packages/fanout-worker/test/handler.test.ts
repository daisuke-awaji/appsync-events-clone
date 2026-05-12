import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { handler } from "../src/handler.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const apigwMock = mockClient(ApiGatewayManagementApiClient);

const decoder = new TextDecoder();

function makeRecord(body: object, id = "msg-1"): SQSRecord {
  return {
    messageId: id,
    receiptHandle: "rh",
    body: JSON.stringify(body),
    attributes: {} as never,
    messageAttributes: {},
    md5OfBody: "",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:us-east-1:123:test",
    awsRegion: "us-east-1",
  };
}

describe("fanout handler", () => {
  beforeEach(() => {
    ddbMock.reset();
    apigwMock.reset();
  });

  it("delivers data frames to all matching subscribers", async () => {
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
        {
          channelPrefix: "/default/room",
          sk: "c2#s2",
          connectionId: "c2",
          subscriptionId: "s2",
          pattern: "/default/room/123",
          namespace: "default",
        },
      ],
    });
    apigwMock.on(PostToConnectionCommand).resolves({});

    const event: SQSEvent = {
      Records: [
        makeRecord({
          channel: "/default/room/123",
          namespace: "default",
          events: ['{"x":1}'],
          publishedAt: 1,
        }),
      ],
    };

    const r = await handler(event);
    expect(r.batchItemFailures).toEqual([]);

    const calls = apigwMock.commandCalls(PostToConnectionCommand);
    expect(calls).toHaveLength(2);
    const targets = calls.map((c) => c.args[0].input.ConnectionId).sort();
    expect(targets).toEqual(["c1", "c2"]);

    const data = JSON.parse(decoder.decode(calls[0]!.args[0].input.Data as Uint8Array)) as {
      action: string;
      channel: string;
      event: string;
    };
    expect(data.action).toBe("data");
    expect(data.channel).toBe("/default/room/123");
    expect(data.event).toBe('{"x":1}');
  });

  it("deletes the connection and its subscriptions on GoneException", async () => {
    // matcher query returns subscriber
    ddbMock
      .on(QueryCommand, { TableName: "TestSubscriptions", KeyConditionExpression: "channelPrefix = :p" })
      .resolves({
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

    // cleanup query for byConnection GSI
    ddbMock
      .on(QueryCommand, { IndexName: "byConnection" })
      .resolves({
        Items: [
          { channelPrefix: "/default/room", sk: "c1#s1", connectionId: "c1", subscriptionId: "s1" },
          { channelPrefix: "/default/chat", sk: "c1#s2", connectionId: "c1", subscriptionId: "s2" },
        ],
      });

    apigwMock
      .on(PostToConnectionCommand)
      .rejects(new GoneException({ message: "gone", $metadata: {} }));
    ddbMock.on(DeleteCommand).resolves({});

    const event: SQSEvent = {
      Records: [
        makeRecord({
          channel: "/default/room/123",
          namespace: "default",
          events: ['{"x":1}'],
        }),
      ],
    };

    const r = await handler(event);
    expect(r.batchItemFailures).toEqual([]);

    const dels = ddbMock.commandCalls(DeleteCommand);
    // 1 connection delete + 2 subscription deletes
    expect(dels.length).toBeGreaterThanOrEqual(3);
    const connectionDel = dels.find(
      (d) => (d.args[0].input.Key as Record<string, unknown>).connectionId === "c1" &&
        !("channelPrefix" in (d.args[0].input.Key as Record<string, unknown>)),
    );
    expect(connectionDel).toBeDefined();
  });

  it("returns batchItemFailures for malformed records", async () => {
    const event: SQSEvent = {
      Records: [
        {
          messageId: "bad",
          receiptHandle: "rh",
          body: "not-json",
          attributes: {} as never,
          messageAttributes: {},
          md5OfBody: "",
          eventSource: "aws:sqs",
          eventSourceARN: "arn",
          awsRegion: "us-east-1",
        },
      ],
    };
    const r = await handler(event);
    expect(r.batchItemFailures).toEqual([{ itemIdentifier: "bad" }]);
  });
});
