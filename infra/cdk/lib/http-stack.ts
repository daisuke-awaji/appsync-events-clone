import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import { type Construct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTTP_API_DIR = path.resolve(__dirname, "../../../packages/http-api/src");

/**
 * Lambda Web Adapter Layer ARN (arm64).
 * Source: https://github.com/aws/aws-lambda-web-adapter
 */
function lwaLayerArn(region: string): string {
  return `arn:aws:lambda:${region}:753240598075:layer:LambdaAdapterLayerArm64:27`;
}

export interface HttpStackProps extends StackProps {
  readonly fanoutQueue: sqs.IQueue;
  readonly apiKey: string;
}

export class HttpStack extends Stack {
  public readonly httpApi: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: HttpStackProps) {
    super(scope, id, props);

    const lwa = lambda.LayerVersion.fromLayerVersionArn(this, "LwaLayer", lwaLayerArn(this.region));

    const fn = new nodejs.NodejsFunction(this, "HttpApiFn", {
      entry: path.join(HTTP_API_DIR, "server.ts"),
      handler: "run.sh",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(15),
      layers: [lwa],
      environment: {
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
        PORT: "8080",
        AWS_LWA_READINESS_CHECK_PATH: "/health",
        FANOUT_QUEUE_URL: props.fanoutQueue.queueUrl,
        API_KEY: props.apiKey,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
      bundling: {
        target: "node20",
        format: nodejs.OutputFormat.ESM,
        mainFields: ["module", "main"],
        banner:
          "import { createRequire as _cr } from 'node:module'; const require = _cr(import.meta.url);",
        sourceMap: true,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string): string[] => [
            // LWA expects the server to be started via run.sh with PATH-like wrapping.
            `printf '#!/bin/sh\\nexec /var/lang/bin/node /var/task/index.mjs\\n' > ${outputDir}/run.sh`,
            `chmod +x ${outputDir}/run.sh`,
          ],
        },
      },
    });

    props.fanoutQueue.grantSendMessages(fn);

    this.httpApi = new apigwv2.HttpApi(this, "EventsHttpApi");
    this.httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration("HttpApiInt", fn),
    });

    new CfnOutput(this, "HttpApiUrl", {
      value: this.httpApi.apiEndpoint,
    });
  }
}
