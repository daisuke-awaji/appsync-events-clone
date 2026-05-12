import { App, CfnOutput, Stack } from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

import { DataStack } from "../lib/data-stack.js";
import { FanoutStack } from "../lib/fanout-stack.js";
import { HttpStack } from "../lib/http-stack.js";
import { WsStack } from "../lib/ws-stack.js";

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

const data = new DataStack(app, "AppSyncEventsClone-Data", { env });

// API key stored in Secrets Manager. On first deploy, a random key is generated.
// Override via CDK context: cdk deploy -c apiKeySecretArn=arn:aws:secretsmanager:...
const existingSecretArn = app.node.tryGetContext("apiKeySecretArn") as string | undefined;

let apiKeySecretArn: string;
if (existingSecretArn) {
  apiKeySecretArn = existingSecretArn;
} else {
  const secretStack = new Stack(app, "AppSyncEventsClone-Secret", { env });
  const secret = new secretsmanager.Secret(secretStack, "ApiKeySecret", {
    description: "API key for AppSync Events Clone",
    generateSecretString: { excludePunctuation: true, passwordLength: 48 },
  });
  apiKeySecretArn = secret.secretArn;
  secretStack.addDependency(data);
}

const ws = new WsStack(app, "AppSyncEventsClone-Ws", {
  env,
  apiKeySecretArn,
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
  apiKeySecretArn,
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
