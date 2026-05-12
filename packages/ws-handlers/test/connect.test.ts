import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handler } from "../src/connect.js";

import { makeWsEvent } from "./fixtures/events.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const apigwMock = mockClient(ApiGatewayManagementApiClient);

describe("connect handler", () => {
  beforeEach(() => {
    ddbMock.reset();
    apigwMock.reset();
  });
  afterEach(() => {
    ddbMock.reset();
    apigwMock.reset();
  });

  it("inserts a row into the Connections table with authorizer context", async () => {
    ddbMock.on(PutCommand).resolves({});
    const evt = makeWsEvent({
      eventType: "CONNECT",
      routeKey: "$connect",
      authorizer: { userId: "alice", authMode: "apiKey" },
    });

    const result = await handler(evt);

    expect(result).toEqual({ statusCode: 200 });
    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({
      TableName: "TestConnections",
      Item: expect.objectContaining({
        connectionId: "test-conn-1",
        userId: "alice",
        authMode: "apiKey",
      }) as object,
    });
    const item = calls[0]!.args[0].input.Item!;
    expect(typeof item.connectedAt).toBe("number");
    expect(typeof item.ttl).toBe("number");
  });

  it("falls back to anonymous when authorizer context is absent", async () => {
    ddbMock.on(PutCommand).resolves({});
    const evt = makeWsEvent({ eventType: "CONNECT", routeKey: "$connect" });

    await handler(evt);

    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls[0]!.args[0].input.Item).toMatchObject({
      userId: "anonymous",
      authMode: "none",
    });
  });
});
