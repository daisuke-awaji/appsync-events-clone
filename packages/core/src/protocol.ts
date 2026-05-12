import { z } from "zod";

/**
 * WebSocket message protocol for the events API.
 * Inspired by the AppSync Events real-time protocol.
 */

export const PUBLISH_MAX_EVENTS = 5;
export const MAX_EVENT_SIZE_BYTES = 128 * 1024; // API Gateway WebSocket message limit
export const MAX_PUBLISH_PAYLOAD_BYTES = 128 * 1024;

/** Stringified JSON event payload. */
const eventStringSchema = z
  .string()
  .min(1)
  .max(MAX_EVENT_SIZE_BYTES, { message: "Event exceeds 128KB" });

export const subscribeMessageSchema = z.object({
  action: z.literal("subscribe"),
  id: z.string().min(1).max(128),
  channel: z.string().min(1),
});

export const unsubscribeMessageSchema = z.object({
  action: z.literal("unsubscribe"),
  id: z.string().min(1).max(128),
});

export const publishMessageSchema = z.object({
  action: z.literal("publish"),
  id: z.string().min(1).max(128),
  channel: z.string().min(1),
  events: z.array(eventStringSchema).min(1).max(PUBLISH_MAX_EVENTS),
});

export const connectionInitMessageSchema = z.object({
  action: z.literal("connection_init"),
});

export const clientMessageSchema = z.discriminatedUnion("action", [
  connectionInitMessageSchema,
  subscribeMessageSchema,
  unsubscribeMessageSchema,
  publishMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;
export type UnsubscribeMessage = z.infer<typeof unsubscribeMessageSchema>;
export type PublishMessage = z.infer<typeof publishMessageSchema>;

export interface ServerMessage {
  readonly action:
    | "connection_ack"
    | "subscribe_success"
    | "subscribe_error"
    | "unsubscribe_success"
    | "publish_success"
    | "publish_error"
    | "data"
    | "ka"
    | "error";
  readonly id?: string;
  readonly [key: string]: unknown;
}

export const httpPublishSchema = z.object({
  channel: z.string().min(1),
  events: z.array(eventStringSchema).min(1).max(PUBLISH_MAX_EVENTS),
});
export type HttpPublishRequest = z.infer<typeof httpPublishSchema>;
