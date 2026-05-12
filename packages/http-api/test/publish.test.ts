import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const sqsMock = mockClient(SQSClient);

const app = createApp();

const goodAuth = { "x-api-key": "test-api-key" };

describe("POST /event", () => {
  beforeEach(() => {
    sqsMock.reset();
    delete process.env.ON_PUBLISH_FN;
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "/default/x", events: ["{}"] }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid publish and enqueues to SQS", async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m1" });

    const res = await app.request("/event", {
      method: "POST",
      headers: { ...goodAuth, "content-type": "application/json" },
      body: JSON.stringify({
        channel: "/default/room/123",
        events: ['{"hello":"world"}'],
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: number; channel: string };
    expect(body).toEqual({ accepted: 1, channel: "/default/room/123" });

    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(calls[0]!.args[0].input.MessageBody!) as {
      channel: string;
      events: string[];
    };
    expect(sent.channel).toBe("/default/room/123");
    expect(sent.events).toEqual(['{"hello":"world"}']);
  });

  it("rejects schema-invalid request with 400", async () => {
    const res = await app.request("/event", {
      method: "POST",
      headers: { ...goodAuth, "content-type": "application/json" },
      body: JSON.stringify({ channel: "" }),
    });
    expect(res.status).toBe(400);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("rejects > 5 events with 400", async () => {
    const res = await app.request("/event", {
      method: "POST",
      headers: { ...goodAuth, "content-type": "application/json" },
      body: JSON.stringify({
        channel: "/default/x",
        events: ["{}", "{}", "{}", "{}", "{}", "{}"],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects channel with wildcard for publish", async () => {
    const res = await app.request("/event", {
      method: "POST",
      headers: { ...goodAuth, "content-type": "application/json" },
      body: JSON.stringify({ channel: "/default/*", events: ["{}"] }),
    });
    expect(res.status).toBe(400);
  });

  it("supports Bearer token", async () => {
    sqsMock.on(SendMessageCommand).resolves({});
    const res = await app.request("/event", {
      method: "POST",
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: "/default/x", events: ["{}"] }),
    });
    expect(res.status).toBe(202);
  });
});

describe("GET /health", () => {
  it("returns ok without auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
