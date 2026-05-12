import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import { type Construct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS_HANDLERS_DIR = path.resolve(__dirname, "../../../packages/ws-handlers/src");

export interface WsStackProps extends StackProps {
  readonly connectionsTable: ddb.ITable;
  readonly subscriptionsTable: ddb.ITable;
  readonly fanoutQueue: sqs.IQueue;
  /** ARN of a Secrets Manager secret containing the API key. */
  readonly apiKeySecretArn: string;
}

export class WsStack extends Stack {
  public readonly api: apigwv2.WebSocketApi;
  public readonly stage: apigwv2.WebSocketStage;
  public readonly endpoint: string;

  constructor(scope: Construct, id: string, props: WsStackProps) {
    super(scope, id, props);

    const apiKeySecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "ApiKeySecret",
      props.apiKeySecretArn,
    );

    const commonEnv: Record<string, string> = {
      CONNECTIONS_TABLE: props.connectionsTable.tableName,
      SUBSCRIPTIONS_TABLE: props.subscriptionsTable.tableName,
      FANOUT_QUEUE_URL: props.fanoutQueue.queueUrl,
    };

    const bundling: nodejs.BundlingOptions = {
      target: "node20",
      format: nodejs.OutputFormat.ESM,
      mainFields: ["module", "main"],
      banner:
        "import { createRequire as _cr } from 'node:module'; const require = _cr(import.meta.url);",
      minify: false,
      sourceMap: true,
    };

    const fn = (name: string, entry: string, env: Record<string, string> = {}) =>
      new nodejs.NodejsFunction(this, name, {
        entry: path.join(WS_HANDLERS_DIR, entry),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: Duration.seconds(15),
        environment: { ...commonEnv, ...env },
        logRetention: logs.RetentionDays.ONE_WEEK,
        bundling,
      });

    const connectFn = fn("ConnectFn", "connect.ts");
    const disconnectFn = fn("DisconnectFn", "disconnect.ts");
    const subscribeFn = fn("SubscribeFn", "subscribe.ts");
    const unsubscribeFn = fn("UnsubscribeFn", "unsubscribe.ts");
    const publishFn = fn("PublishFn", "publish.ts");
    const defaultFn = fn("DefaultFn", "default.ts");

    const authzFn = fn("AuthorizerFn", "authorizer.ts", {
      API_KEY_SECRET_ARN: props.apiKeySecretArn,
    });
    apiKeySecret.grantRead(authzFn);

    // DDB grants
    props.connectionsTable.grantReadWriteData(connectFn);
    props.connectionsTable.grantReadWriteData(disconnectFn);
    props.connectionsTable.grantWriteData(subscribeFn);
    props.connectionsTable.grantWriteData(publishFn);
    props.subscriptionsTable.grantReadWriteData(disconnectFn);
    props.subscriptionsTable.grantWriteData(subscribeFn);
    props.subscriptionsTable.grantReadWriteData(unsubscribeFn);

    // SQS
    props.fanoutQueue.grantSendMessages(publishFn);

    // ----- WebSocket API -----
    const authorizer = new authorizers.WebSocketLambdaAuthorizer("ApiKeyAuthorizer", authzFn, {
      identitySource: ["route.request.querystring.api-key"],
    });

    this.api = new apigwv2.WebSocketApi(this, "EventsApi", {
      routeSelectionExpression: "$request.body.action",
      connectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration("ConnectInt", connectFn),
        authorizer,
      },
      disconnectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration("DisconnectInt", disconnectFn),
      },
      defaultRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration("DefaultInt", defaultFn),
      },
    });

    this.api.addRoute("subscribe", {
      integration: new integrations.WebSocketLambdaIntegration("SubscribeInt", subscribeFn),
    });
    this.api.addRoute("unsubscribe", {
      integration: new integrations.WebSocketLambdaIntegration("UnsubscribeInt", unsubscribeFn),
    });
    this.api.addRoute("publish", {
      integration: new integrations.WebSocketLambdaIntegration("PublishInt", publishFn),
    });

    this.stage = new apigwv2.WebSocketStage(this, "ProdStage", {
      webSocketApi: this.api,
      stageName: "prod",
      autoDeploy: true,
    });

    this.endpoint = `https://${this.api.apiId}.execute-api.${this.region}.amazonaws.com/${this.stage.stageName}`;

    // PostToConnection permission for handlers that send to clients.
    const manageConnPolicy = new iam.PolicyStatement({
      actions: ["execute-api:ManageConnections"],
      resources: [
        `arn:aws:execute-api:${this.region}:${this.account}:${this.api.apiId}/${this.stage.stageName}/POST/@connections/*`,
        `arn:aws:execute-api:${this.region}:${this.account}:${this.api.apiId}/${this.stage.stageName}/DELETE/@connections/*`,
        `arn:aws:execute-api:${this.region}:${this.account}:${this.api.apiId}/${this.stage.stageName}/GET/@connections/*`,
      ],
    });
    [subscribeFn, unsubscribeFn, publishFn, defaultFn].forEach((f) =>
      f.addToRolePolicy(manageConnPolicy),
    );
  }
}
