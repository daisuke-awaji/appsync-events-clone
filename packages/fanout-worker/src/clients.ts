import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { getEnv } from "./env.js";

export const ddb: DynamoDBDocumentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: getEnv().AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

export const apigw: ApiGatewayManagementApiClient = new ApiGatewayManagementApiClient({
  region: getEnv().AWS_REGION,
  endpoint: getEnv().WS_API_ENDPOINT,
});
