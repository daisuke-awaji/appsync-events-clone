import { z } from "zod";

const envSchema = z.object({
  CONNECTIONS_TABLE: z.string().min(1),
  SUBSCRIPTIONS_TABLE: z.string().min(1),
  /** Full WebSocket management endpoint, e.g. `https://abc123.execute-api.us-east-1.amazonaws.com/prod` */
  WS_API_ENDPOINT: z.string().url(),
  AWS_REGION: z.string().default("us-east-1"),
  FANOUT_CONCURRENCY: z.coerce.number().int().positive().default(50),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
