import { z } from "zod";

const envSchema = z.object({
  CONNECTIONS_TABLE: z.string().min(1),
  SUBSCRIPTIONS_TABLE: z.string().min(1),
  FANOUT_QUEUE_URL: z.string().url(),
  ON_PUBLISH_FN: z.string().optional(),
  ON_SUBSCRIBE_FN: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  CONNECTION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3 * 60 * 60),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}

/** For testing only. */
export function resetEnvCache(): void {
  cached = undefined;
}
