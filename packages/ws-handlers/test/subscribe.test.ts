import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { handler } from "../src/subscribe.js";

import { makeWsEvent } from "./fixtures/events.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const apigwMock = mockClient(ApiGatewayManagementApiClient);

const decoder = new TextDecoder();

describe("subscribe handler", () => {
  beforeEach(() => {
    ddbMock.reset();
    apigwMock.reset();
    delete process.env.ON_SUBSCRIBE_FN;
  });

  it("stores subscription with computed channelPrefix and sends ack", async () => {
    ddbMock.on(PutCommand).resolves({});
    apigwMock.on(PostToConnectionCommand).resolves({});

    const evt = makeWsEvent({
      routeKey: "subscribe",
      authorizer: { userId: "alice", authMode: "apiKey" },
      body: { action: "subscribe", id: "sub-1", channel: "/default/room/*" },
    });

    const res = await handler(evt);

    expect(res).toEqual({ statusCode: 200 });
    const put = ddbMock.commandCalls(PutCommand)[0]!;
    expect(put.args[0].input.Item).toMatchObject({
      channelPrefix: "/default/room",
      pattern: "/default/room/*",
      namespace: "default",
      connectionId: "test-conn-1",
      subscriptionId: "sub-1",
    });

    const post = apigwMock.commandCalls(PostToConnectionCommand)[0]!;
    const data = JSON.parse(decoder.decode(post.args[0].input.Data as Uint8Array)) as {
      action: string;
      id: string;
    };
    expect(data).toEqual({ action: "subscribe_success", id: "sub-1" });
  });

  it("rejects channels with invalid characters", async () => {
    apigwMock.on(PostToConnectionCommand).resolves({});

    const evt = makeWsEvent({
      routeKey: "subscribe",
      body: { action: "subscribe", id: "sub-1", channel: "/default/Room_1" },
    });

    const res = await handler(evt);

    expect(res).toEqual({ statusCode: 400 });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    const post = apigwMock.commandCalls(PostToConnectionCommand)[0]!;
    const data = JSON.parse(decoder.decode(post.args[0].input.Data as Uint8Array)) as {
      action: string;
    };
    expect(data.action).toBe("subscribe_error");
  });

  it("rejects malformed message body", async () => {
    apigwMock.on(PostToConnectionCommand).resolves({});

    const evt = makeWsEvent({
      routeKey: "subscribe",
      body: { action: "subscribe" }, // missing id, channel
    });

    const res = await handler(evt);

    expect(res).toEqual({ statusCode: 400 });
  });
});
