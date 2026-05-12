import { describe, expect, it } from "vitest";

import { clientMessageSchema, httpPublishSchema, PUBLISH_MAX_EVENTS } from "../src/index.js";

describe("clientMessageSchema", () => {
  it("accepts subscribe", () => {
    expect(
      clientMessageSchema.parse({ action: "subscribe", id: "s1", channel: "/default/x" }),
    ).toMatchObject({ action: "subscribe" });
  });

  it("accepts publish", () => {
    const msg = clientMessageSchema.parse({
      action: "publish",
      id: "p1",
      channel: "/default/x",
      events: ['{"a":1}'],
    });
    expect(msg.action).toBe("publish");
  });

  it("rejects publish with > 5 events", () => {
    expect(() =>
      clientMessageSchema.parse({
        action: "publish",
        id: "p1",
        channel: "/default/x",
        events: new Array(PUBLISH_MAX_EVENTS + 1).fill("{}"),
      }),
    ).toThrow();
  });

  it("rejects unknown action", () => {
    expect(() => clientMessageSchema.parse({ action: "nope" })).toThrow();
  });
});

describe("httpPublishSchema", () => {
  it("accepts a valid request", () => {
    expect(httpPublishSchema.parse({ channel: "/default/x", events: ['{"a":1}'] })).toMatchObject({
      channel: "/default/x",
    });
  });
});
