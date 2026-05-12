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

const apigwCache = new Map<string, ApiGatewayManagementApiClient>();

/**
 * Return a cached ApiGatewayManagementApiClient for the given WebSocket
 * callback endpoint. Reuses connections across invocations within the same
 * Lambda container.
 */
export function buildApigwClient(domainName: string, stage: string): ApiGatewayManagementApiClient {
  const endpoint = `https://${domainName}/${stage}`;
  let client = apigwCache.get(endpoint);
  if (!client) {
    client = new ApiGatewayManagementApiClient({
      region: getEnv().AWS_REGION,
      endpoint,
    });
    apigwCache.set(endpoint, client);
  }
  return client;
}
