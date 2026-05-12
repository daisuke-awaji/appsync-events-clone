import { z } from "zod";

const envSchema = z.object({
  FANOUT_QUEUE_URL: z.string().url(),
  AWS_REGION: z.string().default("us-east-1"),
  PORT: z.coerce.number().int().positive().default(8080),
  /** Direct API key (local/testing). In production, use API_KEY_SECRET_ARN. */
  API_KEY: z.string().optional(),
  /** ARN of a Secrets Manager secret containing the API key. */
  API_KEY_SECRET_ARN: z.string().optional(),
  ON_PUBLISH_FN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
