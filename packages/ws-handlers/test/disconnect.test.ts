import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { handler } from "../src/disconnect.js";

import { makeWsEventBasic } from "./fixtures/events.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("disconnect handler", () => {
  beforeEach(() => ddbMock.reset());

  it("removes all subscriptions and the connection row", async () => {
    ddbMock.on(QueryCommand, { IndexName: "byConnection" }).resolves({
      Items: [
        { channelPrefix: "/default/room", sk: "test-conn-1#sub-1" },
        { channelPrefix: "/default", sk: "test-conn-1#sub-2" },
      ],
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    ddbMock.on(DeleteCommand).resolves({});

    const evt = makeWsEventBasic({
      eventType: "DISCONNECT",
      routeKey: "$disconnect",
    });

    const r = await handler(evt);

    expect(r).toEqual({ statusCode: 200 });
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(DeleteCommand)[0]!.args[0].input).toMatchObject({
      TableName: "TestConnections",
      Key: { connectionId: "test-conn-1" },
    });
  });

  it("retries UnprocessedItems from BatchWrite", async () => {
    ddbMock.on(QueryCommand, { IndexName: "byConnection" }).resolves({
      Items: [
        { channelPrefix: "/default/room", sk: "test-conn-1#sub-1" },
      ],
    });
    let call = 0;
    ddbMock.on(BatchWriteCommand).callsFake(() => {
      call++;
      if (call === 1) {
        return {
          UnprocessedItems: {
            TestSubscriptions: [
              { DeleteRequest: { Key: { channelPrefix: "/default/room", sk: "test-conn-1#sub-1" } } },
            ],
          },
        };
      }
      return { UnprocessedItems: {} };
    });
    ddbMock.on(DeleteCommand).resolves({});

    const evt = makeWsEventBasic({ eventType: "DISCONNECT", routeKey: "$disconnect" });
    const r = await handler(evt);

    expect(r).toEqual({ statusCode: 200 });
    expect(ddbMock.commandCalls(BatchWriteCommand).length).toBeGreaterThanOrEqual(2);
  });

  it("handles a connection with no subscriptions", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(DeleteCommand).resolves({});

    const evt = makeWsEventBasic({
      eventType: "DISCONNECT",
      routeKey: "$disconnect",
    });
    const r = await handler(evt);

    expect(r).toEqual({ statusCode: 200 });
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });
});
