import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface HookResult {
  readonly allow: boolean;
  readonly reason?: string;
  readonly events?: string[];
  readonly filter?: string;
}

/**
 * Invoke a Lambda handler hook (onPublish / onSubscribe) and return the result.
 * On function error or missing payload, defaults to `{ allow: true }`.
 */
export async function invokeHook(
  client: LambdaClient,
  fnName: string,
  payload: Record<string, unknown>,
): Promise<HookResult> {
  const res = await client.send(
    new InvokeCommand({
      FunctionName: fnName,
      InvocationType: "RequestResponse",
      Payload: encoder.encode(JSON.stringify(payload)),
    }),
  );
  if (res.FunctionError) {
    return { allow: false, reason: `handler error: ${res.FunctionError}` };
  }
  if (!res.Payload) return { allow: true };
  return JSON.parse(decoder.decode(res.Payload)) as HookResult;
}
