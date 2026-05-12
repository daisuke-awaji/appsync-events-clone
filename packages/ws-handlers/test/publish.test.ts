import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { handler } from "../src/publish.js";

import { makeWsEvent } from "./fixtures/events.js";

const sqsMock = mockClient(SQSClient);
const apigwMock = mockClient(ApiGatewayManagementApiClient);

const decoder = new TextDecoder();

describe("publish handler", () => {
  beforeEach(() => {
    sqsMock.reset();
    apigwMock.reset();
    delete process.env.ON_PUBLISH_FN;
  });

  it("enqueues to SQS and acks the publisher", async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m1" });
    apigwMock.on(PostToConnectionCommand).resolves({});

    const evt = makeWsEvent({
      routeKey: "publish",
      body: {
        action: "publish",
        id: "p-1",
        channel: "/default/room/123",
        events: ['{"hello":"world"}'],
      },
    });

    const res = await handler(evt);

    expect(res).toEqual({ statusCode: 200 });
    const sqsCall = sqsMock.commandCalls(SendMessageCommand)[0]!;
    const body = JSON.parse(sqsCall.args[0].input.MessageBody!) as {
      channel: string;
      namespace: string;
      events: string[];
    };
    expect(body.channel).toBe("/default/room/123");
    expect(body.namespace).toBe("default");
    expect(body.events).toEqual(['{"hello":"world"}']);

    const post = apigwMock.commandCalls(PostToConnectionCommand)[0]!;
    const ack = JSON.parse(decoder.decode(post.args[0].input.Data as Uint8Array)) as {
      action: string;
      id: string;
    };
    expect(ack).toEqual({ action: "publish_success", id: "p-1" });
  });

  it("rejects publish with wildcard channel", async () => {
    apigwMock.on(PostToConnectionCommand).resolves({});

    const evt = makeWsEvent({
      routeKey: "publish",
      body: {
        action: "publish",
        id: "p-1",
        channel: "/default/room/*",
        events: ["{}"],
      },
    });

    const res = await handler(evt);

    expect(res).toEqual({ statusCode: 400 });
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("rejects publish with > 5 events", async () => {
    apigwMock.on(PostToConnectionCommand).resolves({});

    const evt = makeWsEvent({
      routeKey: "publish",
      body: {
        action: "publish",
        id: "p-1",
        channel: "/default/room/123",
        events: ["{}", "{}", "{}", "{}", "{}", "{}"],
      },
    });

    const res = await handler(evt);
    expect(res).toEqual({ statusCode: 400 });
  });
});
