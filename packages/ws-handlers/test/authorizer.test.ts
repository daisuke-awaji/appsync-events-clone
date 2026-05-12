import { describe, expect, it } from "vitest";

import { handler } from "../src/authorizer.js";

function event(opts: {
  qs?: Record<string, string>;
  headers?: Record<string, string>;
}): Parameters<typeof handler>[0] {
  return {
    type: "REQUEST",
    methodArn: "arn:aws:execute-api:us-east-1:123:abc/prod/$connect",
    queryStringParameters: opts.qs ?? {},
    headers: opts.headers ?? {},
  } as unknown as Parameters<typeof handler>[0];
}

describe("authorizer", () => {
  it("authorizes when api-key query param matches", async () => {
    const r = await handler(event({ qs: { "api-key": "test-api-key" } }));
    expect(r.isAuthorized).toBe(true);
    expect(r.context.userId).toBe("api-key-user");
    expect(r.context.authMode).toBe("apiKey");
  });

  it("authorizes when x-api-key header matches", async () => {
    const r = await handler(event({ headers: { "x-api-key": "test-api-key" } }));
    expect(r.isAuthorized).toBe(true);
  });

  it("denies when key is wrong", async () => {
    const r = await handler(event({ qs: { "api-key": "wrong" } }));
    expect(r.isAuthorized).toBe(false);
  });

  it("denies when key is missing", async () => {
    const r = await handler(event({}));
    expect(r.isAuthorized).toBe(false);
  });
});
