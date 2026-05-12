import type {
  APIGatewayProxyWebsocketEventV2,
  APIGatewayProxyWebsocketEventV2WithRequestContext,
  APIGatewayEventWebsocketRequestContextV2,
} from "aws-lambda";

interface AuthLambdaCtx {
  readonly userId?: string;
  readonly authMode?: string;
}

interface MakeEventOpts {
  readonly connectionId?: string;
  readonly routeKey?: string;
  readonly eventType?: "CONNECT" | "DISCONNECT" | "MESSAGE";
  readonly body?: unknown;
  readonly authorizer?: AuthLambdaCtx;
}

export function makeWsEvent(
  opts: MakeEventOpts = {},
): APIGatewayProxyWebsocketEventV2WithRequestContext<
  APIGatewayEventWebsocketRequestContextV2 & {
    readonly authorizer?: { readonly lambda?: AuthLambdaCtx };
  }
> {
  const connectionId = opts.connectionId ?? "test-conn-1";
  const requestContext = {
    routeKey: opts.routeKey ?? "$default",
    eventType: opts.eventType ?? "MESSAGE",
    connectionId,
    apiId: "abc123",
    domainName: "abc123.execute-api.us-east-1.amazonaws.com",
    stage: "prod",
    requestId: "req-1",
    extendedRequestId: "ereq-1",
    connectedAt: 1_700_000_000_000,
    requestTimeEpoch: 1_700_000_000_000,
    requestTime: "12/Jan/2024:00:00:00 +0000",
    messageDirection: "IN",
    messageId: "msg-1",
    identity: {
      accessKey: null,
      accountId: null,
      caller: null,
      cognitoAuthenticationProvider: null,
      cognitoAuthenticationType: null,
      cognitoIdentityId: null,
      cognitoIdentityPoolId: null,
      principalOrgId: null,
      sourceIp: "127.0.0.1",
      user: null,
      userAgent: null,
      userArn: null,
    },
    ...(opts.authorizer ? { authorizer: { lambda: opts.authorizer } } : {}),
  };

  return {
    requestContext,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyWebsocketEventV2WithRequestContext<
    APIGatewayEventWebsocketRequestContextV2 & {
      readonly authorizer?: { readonly lambda?: AuthLambdaCtx };
    }
  >;
}

export function makeWsEventBasic(opts: MakeEventOpts = {}): APIGatewayProxyWebsocketEventV2 {
  return makeWsEvent(opts);
}
