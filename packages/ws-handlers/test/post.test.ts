import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DeleteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { buildApigwClient } from "../src/shared/clients.js";
import { postToConnection } from "../src/shared/post.js";

const ddbMock = mockClient(DynamoDBDocumentClient);
const apigwMock = mockClient(ApiGatewayManagementApiClient);

describe("postToConnection", () => {
  beforeEach(() => {
    ddbMock.reset();
    apigwMock.reset();
  });

  it("posts a message and reports delivered", async () => {
    apigwMock.on(PostToConnectionCommand).resolves({});

    const c = buildApigwClient("api.example.com", "prod");
    const r = await postToConnection(c, "conn-1", { action: "ka" });

    expect(r).toEqual({ delivered: true, gone: false });
    expect(apigwMock.commandCalls(PostToConnectionCommand)).toHaveLength(1);
  });

  it("deletes the connection on GoneException", async () => {
    apigwMock
      .on(PostToConnectionCommand)
      .rejects(new GoneException({ message: "gone", $metadata: {} }));
    ddbMock.on(DeleteCommand).resolves({});

    const c = buildApigwClient("api.example.com", "prod");
    const r = await postToConnection(c, "conn-1", { action: "data" });

    expect(r).toEqual({ delivered: false, gone: true });
    const del = ddbMock.commandCalls(DeleteCommand)[0]!;
    expect(del.args[0].input.Key).toEqual({ connectionId: "conn-1" });
  });

  it("rethrows non-Gone errors", async () => {
    apigwMock.on(PostToConnectionCommand).rejects(new Error("boom"));
    const c = buildApigwClient("api.example.com", "prod");
    await expect(postToConnection(c, "conn-1", { action: "data" })).rejects.toThrow("boom");
  });
});
