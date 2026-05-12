import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { getEnv } from "./env.js";

export const ddb: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: getEnv().AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

export const sqs: SQSClient = new SQSClient({ region: getEnv().AWS_REGION });

export const lambda: LambdaClient = new LambdaClient({ region: getEnv().AWS_REGION });

/**
 * Build an ApiGatewayManagementApiClient bound to a specific WebSocket API
 * callback URL. The URL is provided by API Gateway in the request context as
 * `${domainName}/${stage}` and must be prefixed with `https://`.
 */
export function buildApigwClient(domainName: string, stage: string): ApiGatewayManagementApiClient {
  return new ApiGatewayManagementApiClient({
    region: getEnv().AWS_REGION,
    endpoint: `https://${domainName}/${stage}`,
  });
}
