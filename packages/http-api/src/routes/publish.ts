import {
  ChannelValidationError,
  httpPublishSchema,
  invokeHook,
  parsePublishChannel,
} from "@appsync-events-clone/core";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";

import { lambda, sqs } from "../clients.js";
import { getEnv } from "../env.js";

export const publishRoutes: Hono = new Hono();

publishRoutes.post(
  "/event",
  zValidator("json", httpPublishSchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "Invalid request", details: result.error.issues }, 400);
    }
    return undefined;
  }),
  async (c: Context) => {
    const env = getEnv();
    const { channel, events } = c.req.valid("json" as never) as {
      channel: string;
      events: string[];
    };

    let parsed;
    try {
      parsed = parsePublishChannel(channel);
    } catch (err) {
      if (err instanceof ChannelValidationError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    let outgoing = events;
    if (env.ON_PUBLISH_FN) {
      const userId = (c.get("userId") as string | undefined) ?? "anonymous";
      const result = await invokeHook(lambda, env.ON_PUBLISH_FN, {
        channel: parsed.raw,
        namespace: parsed.namespace,
        userId,
        events,
      });
      if (!result.allow) {
        return c.json({ error: "Forbidden", reason: result.reason }, 403);
      }
      if (result.events) outgoing = result.events;
    }

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: env.FANOUT_QUEUE_URL,
        MessageBody: JSON.stringify({
          channel: parsed.raw,
          namespace: parsed.namespace,
          events: outgoing,
          publishedAt: Date.now(),
        }),
      }),
    );

    return c.json({ accepted: outgoing.length, channel: parsed.raw }, 202);
  },
);
