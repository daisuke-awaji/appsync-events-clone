import {
  ChannelValidationError,
  invokeHook,
  parseSubscribePattern,
  subscribeMessageSchema,
} from "@appsync-events-clone/core";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2WithRequestContext,
  APIGatewayEventWebsocketRequestContextV2,
} from "aws-lambda";

import { buildApigwClient, ddb, lambda } from "./shared/clients.js";
import { getEnv } from "./shared/env.js";
import { logger } from "./shared/logger.js";
import { postToConnection } from "./shared/post.js";

type SubEvent = APIGatewayProxyWebsocketEventV2WithRequestContext<
  APIGatewayEventWebsocketRequestContextV2 & {
    readonly authorizer?: { readonly lambda?: { readonly userId?: string } };
  }
>;

export const handler = async (event: SubEvent): Promise<APIGatewayProxyResultV2> => {
  const env = getEnv();
  const { connectionId, domainName, stage } = event.requestContext;
  const apigw = buildApigwClient(domainName, stage);

  let parsed;
  try {
    parsed = subscribeMessageSchema.parse(JSON.parse(event.body ?? "{}"));
  } catch (err) {
    await postToConnection(apigw, connectionId, {
      action: "error",
      message: "invalid subscribe message",
      detail: (err as Error).message,
    });
    return { statusCode: 400 };
  }

  let pattern;
  try {
    pattern = parseSubscribePattern(parsed.channel);
  } catch (err) {
    if (err instanceof ChannelValidationError) {
      await postToConnection(apigw, connectionId, {
        action: "subscribe_error",
        id: parsed.id,
        errors: [{ errorType: "ChannelValidationError", message: err.message }],
      });
      return { statusCode: 400 };
    }
    throw err;
  }

  if (env.ON_SUBSCRIBE_FN) {
    const userId = event.requestContext.authorizer?.lambda?.userId ?? "anonymous";
    const result = await invokeHook(lambda, env.ON_SUBSCRIBE_FN, {
      channel: parsed.channel,
      namespace: pattern.namespace,
      userId,
    });
    if (!result.allow) {
      await postToConnection(apigw, connectionId, {
        action: "subscribe_error",
        id: parsed.id,
        errors: [{ errorType: "Forbidden", message: result.reason ?? "denied" }],
      });
      return { statusCode: 403 };
    }
  }

  await ddb.send(
    new PutCommand({
      TableName: env.SUBSCRIPTIONS_TABLE,
      Item: {
        channelPrefix: pattern.channelPrefix,
        sk: `${connectionId}#${parsed.id}`,
        connectionId,
        subscriptionId: parsed.id,
        pattern: pattern.raw,
        namespace: pattern.namespace,
        subscribedAt: Date.now(),
      },
    }),
  );

  await postToConnection(apigw, connectionId, {
    action: "subscribe_success",
    id: parsed.id,
  });

  logger.info("subscribe", {
    connectionId,
    subscriptionId: parsed.id,
    pattern: pattern.raw,
  });
  return { statusCode: 200 };
};
