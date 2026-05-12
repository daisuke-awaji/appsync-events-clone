import { LambdaClient } from "@aws-sdk/client-lambda";
import { SQSClient } from "@aws-sdk/client-sqs";

import { getEnv } from "./env.js";

export const sqs: SQSClient = new SQSClient({ region: getEnv().AWS_REGION });
export const lambda: LambdaClient = new LambdaClient({ region: getEnv().AWS_REGION });
