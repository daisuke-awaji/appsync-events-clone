import {
  ChannelValidationError,
  parsePublishChannel,
  publishMessageSchema,
} from "@appsync-events-clone/core";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2WithRequestContext,
  APIGatewayEventWebsocketRequestContextV2,
} from "aws-lambda";

import { buildApigwClient, lambda, sqs } from "./shared/clients.js";
import { getEnv } from "./shared/env.js";
import { logger } from "./shared/logger.js";
import { postToConnection } from "./shared/post.js";

type PubEvent = APIGatewayProxyWebsocketEventV2WithRequestContext<
  APIGatewayEventWebsocketRequestContextV2 & {
    readonly authorizer?: { readonly lambda?: { readonly userId?: string } };
  }
>;

interface OnPublishResult {
  readonly allow: boolean;
  readonly reason?: string;
  readonly events?: string[];
}

const decoder = new TextDecoder();

async function invokeOnPublish(
  fnName: string,
  payload: { channel: string; namespace: string; userId: string; events: string[] },
): Promise<OnPublishResult> {
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: fnName,
      InvocationType: "RequestResponse",
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
  );
  if (res.FunctionError) {
    return { allow: false, reason: `handler error: ${res.FunctionError}` };
  }
  if (!res.Payload) {
    return { allow: true };
  }
  return JSON.parse(decoder.decode(res.Payload)) as OnPublishResult;
}

export interface FanoutMessage {
  readonly channel: string;
  readonly namespace: string;
  readonly events: string[];
  readonly publishedAt: number;
  readonly publisherConnectionId?: string;
}

export const handler = async (event: PubEvent): Promise<APIGatewayProxyResultV2> => {
  const env = getEnv();
  const { connectionId, domainName, stage } = event.requestContext;
  const apigw = buildApigwClient(domainName, stage);

  let parsed;
  try {
    parsed = publishMessageSchema.parse(JSON.parse(event.body ?? "{}"));
  } catch (err) {
    await postToConnection(apigw, connectionId, {
      action: "error",
      message: "invalid publish message",
      detail: (err as Error).message,
    });
    return { statusCode: 400 };
  }

  let channel;
  try {
    channel = parsePublishChannel(parsed.channel);
  } catch (err) {
    if (err instanceof ChannelValidationError) {
      await postToConnection(apigw, connectionId, {
        action: "publish_error",
        id: parsed.id,
        errors: [{ errorType: "ChannelValidationError", message: err.message }],
      });
      return { statusCode: 400 };
    }
    throw err;
  }

  let outgoingEvents = parsed.events;

  if (env.ON_PUBLISH_FN) {
    const userId = event.requestContext.authorizer?.lambda?.userId ?? "anonymous";
    const result = await invokeOnPublish(env.ON_PUBLISH_FN, {
      channel: channel.raw,
      namespace: channel.namespace,
      userId,
      events: parsed.events,
    });
    if (!result.allow) {
      await postToConnection(apigw, connectionId, {
        action: "publish_error",
        id: parsed.id,
        errors: [{ errorType: "Forbidden", message: result.reason ?? "denied" }],
      });
      return { statusCode: 403 };
    }
    if (result.events) {
      outgoingEvents = result.events;
    }
  }

  const message: FanoutMessage = {
    channel: channel.raw,
    namespace: channel.namespace,
    events: outgoingEvents,
    publishedAt: Date.now(),
    publisherConnectionId: connectionId,
  };

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: env.FANOUT_QUEUE_URL,
      MessageBody: JSON.stringify(message),
    }),
  );

  await postToConnection(apigw, connectionId, {
    action: "publish_success",
    id: parsed.id,
  });

  logger.info("publish", {
    connectionId,
    channel: channel.raw,
    eventCount: outgoingEvents.length,
  });
  return { statusCode: 200 };
};
