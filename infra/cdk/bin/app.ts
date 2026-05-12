import { App, CfnOutput, Stack } from "aws-cdk-lib";

import { DataStack } from "../lib/data-stack.js";
import { FanoutStack } from "../lib/fanout-stack.js";
import { HttpStack } from "../lib/http-stack.js";
import { WsStack } from "../lib/ws-stack.js";

const app = new App();

// MVP: read API key from CDK context (cdk deploy -c apiKey=xxx).
// Replace with AWS Secrets Manager for production.
const apiKey = (app.node.tryGetContext("apiKey") as string | undefined) ?? "dev-api-key";

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

const data = new DataStack(app, "AppSyncEventsClone-Data", { env });

const ws = new WsStack(app, "AppSyncEventsClone-Ws", {
  env,
  apiKey,
  connectionsTable: data.connectionsTable,
  subscriptionsTable: data.subscriptionsTable,
  fanoutQueue: data.fanoutQueue,
});
ws.addDependency(data);

const fanout = new FanoutStack(app, "AppSyncEventsClone-Fanout", {
  env,
  connectionsTable: data.connectionsTable,
  subscriptionsTable: data.subscriptionsTable,
  fanoutQueue: data.fanoutQueue,
  wsApiEndpoint: ws.endpoint,
  wsApiId: ws.api.apiId,
  stageName: ws.stage.stageName,
});
fanout.addDependency(ws);

const http = new HttpStack(app, "AppSyncEventsClone-Http", {
  env,
  apiKey,
  fanoutQueue: data.fanoutQueue,
});
http.addDependency(data);

// Convenience output
const meta = new Stack(app, "AppSyncEventsClone-Meta", { env });
new CfnOutput(meta, "WebSocketEndpoint", {
  value: `wss://${ws.api.apiId}.execute-api.${ws.region}.amazonaws.com/${ws.stage.stageName}`,
});
new CfnOutput(meta, "HttpEndpoint", { value: http.httpApi.apiEndpoint });
meta.addDependency(ws);
meta.addDependency(http);
