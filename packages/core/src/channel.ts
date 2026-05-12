import { ChannelValidationError } from "./errors.js";

/**
 * AppSync Events compatible channel path rules.
 *
 * - Channel paths are slash-delimited: `/segment1/segment2/...`
 * - Maximum 5 segments.
 * - Each segment: 1..50 chars, alphanumeric and hyphen, must start/end with alphanumeric.
 * - Case sensitive.
 * - The first segment is the namespace.
 * - For subscriptions, segments may be the wildcards `*` (single segment) or `**` (multi segment, only at end).
 *
 * Sources:
 *   https://docs.aws.amazon.com/appsync/latest/eventapi/channel-namespaces.html
 *   https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html
 */
export const CHANNEL_MAX_SEGMENTS = 5;
export const SEGMENT_MAX_LENGTH = 50;

const SEGMENT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/;

export interface ParsedChannel {
  /** Original (normalized) path string, e.g. `/default/room/123`. */
  readonly raw: string;
  /** Path segments without the leading slash. */
  readonly segments: readonly string[];
  /** First segment, treated as the AppSync Events namespace. */
  readonly namespace: string;
  /** True if the channel contains a `*` or `**` wildcard. */
  readonly hasWildcard: boolean;
  /**
   * Fixed prefix (with leading slash) before any wildcard segment.
   * Used as a DynamoDB partition key for efficient lookup of subscriptions.
   * For non-wildcard channels this is the full path without trailing slash.
   */
  readonly channelPrefix: string;
}

interface ParseOptions {
  readonly allowWildcard: boolean;
}

function normalize(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ChannelValidationError("Channel must be a non-empty string");
  }
  if (!raw.startsWith("/")) {
    throw new ChannelValidationError(`Channel must start with '/': ${raw}`);
  }
  // Trim trailing slash (but keep root "/" invalid below).
  const trimmed = raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (trimmed === "/") {
    throw new ChannelValidationError("Channel must contain at least one segment");
  }
  return trimmed;
}

function parse(raw: string, opts: ParseOptions): ParsedChannel {
  const normalized = normalize(raw);
  const segments = normalized.slice(1).split("/");

  if (segments.length === 0) {
    throw new ChannelValidationError("Channel must contain at least one segment");
  }
  if (segments.length > CHANNEL_MAX_SEGMENTS) {
    throw new ChannelValidationError(
      `Channel exceeds maximum of ${CHANNEL_MAX_SEGMENTS} segments: ${raw}`,
    );
  }

  let firstWildcardIdx = -1;
  for (const [i, seg] of segments.entries()) {
    if (seg.length === 0) {
      throw new ChannelValidationError(`Channel contains empty segment: ${raw}`);
    }
    if (seg.length > SEGMENT_MAX_LENGTH) {
      throw new ChannelValidationError(`Segment exceeds ${SEGMENT_MAX_LENGTH} characters: ${seg}`);
    }

    const isWildcard = seg === "*" || seg === "**";
    if (isWildcard) {
      if (!opts.allowWildcard) {
        throw new ChannelValidationError(`Wildcards are not allowed in this context: ${raw}`);
      }
      if (i === 0) {
        throw new ChannelValidationError(
          `Wildcards are not allowed in the namespace segment: ${raw}`,
        );
      }
      if (seg === "**" && i !== segments.length - 1) {
        throw new ChannelValidationError(
          `Globstar '**' is only allowed as the last segment: ${raw}`,
        );
      }
      if (firstWildcardIdx === -1) {
        firstWildcardIdx = i;
      }
      continue;
    }

    if (!SEGMENT_RE.test(seg)) {
      throw new ChannelValidationError(
        `Invalid segment '${seg}' in channel '${raw}'. Allowed: alphanumeric and hyphen, must start/end with alphanumeric.`,
      );
    }
  }

  const namespace = segments[0]!;
  const hasWildcard = firstWildcardIdx !== -1;
  const prefixSegments = hasWildcard ? segments.slice(0, firstWildcardIdx) : segments;
  const channelPrefix = `/${prefixSegments.join("/")}`;

  return {
    raw: normalized,
    segments,
    namespace,
    hasWildcard,
    channelPrefix,
  };
}

/** Parse a concrete channel path used for publishing. Wildcards are rejected. */
export function parsePublishChannel(raw: string): ParsedChannel {
  return parse(raw, { allowWildcard: false });
}

/** Parse a subscription pattern. Wildcards (`*`, `**`) are allowed. */
export function parseSubscribePattern(raw: string): ParsedChannel {
  return parse(raw, { allowWildcard: true });
}

/**
 * Test whether `concrete` matches `pattern`.
 * `pattern` may include wildcards; `concrete` must not.
 */
export function matchesPattern(pattern: ParsedChannel, concrete: ParsedChannel): boolean {
  if (concrete.hasWildcard) {
    throw new ChannelValidationError("Concrete channel must not contain wildcards");
  }
  if (pattern.namespace !== concrete.namespace) {
    return false;
  }

  const p = pattern.segments;
  const c = concrete.segments;

  for (let i = 0; i < p.length; i++) {
    const ps = p[i]!;
    if (ps === "**") {
      // Globstar matches one or more remaining segments. Must be last in pattern.
      return c.length >= i + 1;
    }
    if (i >= c.length) {
      return false;
    }
    const cs = c[i]!;
    if (ps === "*") {
      continue;
    }
    if (ps !== cs) {
      return false;
    }
  }
  return p.length === c.length;
}

/**
 * Compute the candidate channel prefixes that should be queried in DynamoDB
 * to find subscriptions matching a given concrete channel.
 *
 * For a concrete path `/a/b/c`, returns the inclusive prefix list
 * `["/a", "/a/b", "/a/b/c"]`. A subscription pattern is stored under its
 * `channelPrefix` (the fixed part before any wildcard), so any subscription
 * that could match the concrete channel will be discovered by querying
 * one of these prefixes.
 */
export function candidatePrefixes(concrete: ParsedChannel): string[] {
  if (concrete.hasWildcard) {
    throw new ChannelValidationError("Concrete channel must not contain wildcards");
  }
  const prefixes: string[] = [];
  for (let i = 1; i <= concrete.segments.length; i++) {
    prefixes.push(`/${concrete.segments.slice(0, i).join("/")}`);
  }
  return prefixes;
}
