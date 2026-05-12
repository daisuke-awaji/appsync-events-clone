import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import type * as ddb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as eventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import { type Construct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FANOUT_DIR = path.resolve(__dirname, "../../../packages/fanout-worker/src");

export interface FanoutStackProps extends StackProps {
  readonly connectionsTable: ddb.ITable;
  readonly subscriptionsTable: ddb.ITable;
  readonly fanoutQueue: sqs.IQueue;
  /** WebSocket management endpoint, e.g. `https://<id>.execute-api.<region>.amazonaws.com/prod` */
  readonly wsApiEndpoint: string;
  readonly wsApiId: string;
  readonly stageName: string;
}

export class FanoutStack extends Stack {
  constructor(scope: Construct, id: string, props: FanoutStackProps) {
    super(scope, id, props);

    const fn = new nodejs.NodejsFunction(this, "FanoutWorker", {
      entry: path.join(FANOUT_DIR, "handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(60),
      environment: {
        CONNECTIONS_TABLE: props.connectionsTable.tableName,
        SUBSCRIPTIONS_TABLE: props.subscriptionsTable.tableName,
        WS_API_ENDPOINT: props.wsApiEndpoint,
        FANOUT_CONCURRENCY: "50",
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      bundling: {
        target: "node20",
        format: nodejs.OutputFormat.ESM,
        mainFields: ["module", "main"],
        banner:
          "import { createRequire as _cr } from 'node:module'; const require = _cr(import.meta.url);",
        sourceMap: true,
      },
    });

    fn.addEventSource(
      new eventSources.SqsEventSource(props.fanoutQueue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(1),
        reportBatchItemFailures: true,
      }),
    );

    props.connectionsTable.grantReadWriteData(fn);
    props.subscriptionsTable.grantReadData(fn);

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:ManageConnections"],
        resources: [
          `arn:aws:execute-api:${this.region}:${this.account}:${props.wsApiId}/${props.stageName}/POST/@connections/*`,
        ],
      }),
    );
  }
}
