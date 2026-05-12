import { z } from "zod";

const envSchema = z.object({
  FANOUT_QUEUE_URL: z.string().url(),
  AWS_REGION: z.string().default("us-east-1"),
  PORT: z.coerce.number().int().positive().default(8080),
  /** API key required for HTTP publish (Bearer or x-api-key header). */
  API_KEY: z.string().min(1),
  ON_PUBLISH_FN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
