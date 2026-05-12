import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";

import { DataStack } from "../lib/data-stack.js";
import { FanoutStack } from "../lib/fanout-stack.js";
import { HttpStack } from "../lib/http-stack.js";
import { WsStack } from "../lib/ws-stack.js";

function buildApp() {
  const app = new App();
  const env = { account: "123456789012", region: "us-east-1" };
  const data = new DataStack(app, "Data", { env });
  const ws = new WsStack(app, "Ws", {
    env,
    apiKey: "test",
    connectionsTable: data.connectionsTable,
    subscriptionsTable: data.subscriptionsTable,
    fanoutQueue: data.fanoutQueue,
  });
  const fanout = new FanoutStack(app, "Fanout", {
    env,
    connectionsTable: data.connectionsTable,
    subscriptionsTable: data.subscriptionsTable,
    fanoutQueue: data.fanoutQueue,
    wsApiEndpoint: ws.endpoint,
    wsApiId: ws.api.apiId,
    stageName: ws.stage.stageName,
  });
  const http = new HttpStack(app, "Http", {
    env,
    apiKey: "test",
    fanoutQueue: data.fanoutQueue,
  });
  return { app, data, ws, fanout, http };
}

describe("CDK synth", () => {
  it("Data stack has Connections + Subscriptions tables and SQS queues", () => {
    const { data } = buildApp();
    const t = Template.fromStack(data);
    t.resourceCountIs("AWS::DynamoDB::Table", 2);
    t.resourceCountIs("AWS::SQS::Queue", 2);
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: Match.arrayWith([{ AttributeName: "connectionId", KeyType: "HASH" }]),
    });
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: Match.arrayWith([
        { AttributeName: "channelPrefix", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ]),
    });
  });

  it("WS stack creates a WebSocket API with route selection on action", () => {
    const { ws } = buildApp();
    const t = Template.fromStack(ws);
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "WEBSOCKET",
      RouteSelectionExpression: "$request.body.action",
    });
    // 6 routes: $connect, $disconnect, $default, subscribe, unsubscribe, publish
    t.resourceCountIs("AWS::ApiGatewayV2::Route", 6);
  });

  it("Fanout stack subscribes the worker to SQS with partial batch failures", () => {
    const { fanout } = buildApp();
    const t = Template.fromStack(fanout);
    t.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
  });

  it("Http stack uses the LWA layer and proxies all routes", () => {
    const { http } = buildApp();
    const t = Template.fromStack(http);
    t.hasResourceProperties("AWS::Lambda::Function", {
      Layers: Match.arrayWith([
        Match.stringLikeRegexp(":753240598075:layer:LambdaAdapterLayerArm64:"),
      ]),
      Environment: {
        Variables: Match.objectLike({
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
          AWS_LWA_READINESS_CHECK_PATH: "/health",
        }),
      },
    });
  });
});
