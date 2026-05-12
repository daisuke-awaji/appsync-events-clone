import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  candidatePrefixes,
  ChannelValidationError,
  matchesPattern,
  parsePublishChannel,
  parseSubscribePattern,
} from "../src/index.js";

describe("parsePublishChannel", () => {
  it("parses a simple path", () => {
    const c = parsePublishChannel("/default/room/123");
    expect(c.namespace).toBe("default");
    expect(c.segments).toEqual(["default", "room", "123"]);
    expect(c.hasWildcard).toBe(false);
    expect(c.channelPrefix).toBe("/default/room/123");
  });

  it("normalizes trailing slash", () => {
    expect(parsePublishChannel("/default/room/").raw).toBe("/default/room");
  });

  it("rejects channels without leading slash", () => {
    expect(() => parsePublishChannel("default/room")).toThrow(ChannelValidationError);
  });

  it("rejects channels with > 5 segments", () => {
    expect(() => parsePublishChannel("/a/b/c/d/e/f")).toThrow(/maximum of 5 segments/);
  });

  it("rejects segments > 50 chars", () => {
    const long = "a".repeat(51);
    expect(() => parsePublishChannel(`/default/${long}`)).toThrow(/exceeds 50/);
  });

  it("rejects segments with disallowed characters", () => {
    expect(() => parsePublishChannel("/default/Room_1")).toThrow(/Invalid segment/);
    expect(() => parsePublishChannel("/default/room.1")).toThrow(/Invalid segment/);
    expect(() => parsePublishChannel("/default/-leading")).toThrow(/Invalid segment/);
    expect(() => parsePublishChannel("/default/trailing-")).toThrow(/Invalid segment/);
  });

  it("rejects wildcards in publish context", () => {
    expect(() => parsePublishChannel("/default/room/*")).toThrow(/Wildcards are not allowed/);
    expect(() => parsePublishChannel("/default/**")).toThrow(/Wildcards are not allowed/);
  });

  it("rejects empty path", () => {
    expect(() => parsePublishChannel("/")).toThrow();
    expect(() => parsePublishChannel("")).toThrow();
  });

  it("accepts hyphenated segments", () => {
    expect(parsePublishChannel("/default/my-room/abc-123").segments).toEqual([
      "default",
      "my-room",
      "abc-123",
    ]);
  });

  it("is case sensitive", () => {
    const a = parsePublishChannel("/Default/Room");
    const b = parsePublishChannel("/default/room");
    expect(a.namespace).not.toBe(b.namespace);
  });
});

describe("parseSubscribePattern", () => {
  it("allows single-segment wildcard", () => {
    const c = parseSubscribePattern("/default/room/*");
    expect(c.hasWildcard).toBe(true);
    expect(c.channelPrefix).toBe("/default/room");
  });

  it("allows globstar at end", () => {
    const c = parseSubscribePattern("/default/room/**");
    expect(c.hasWildcard).toBe(true);
    expect(c.channelPrefix).toBe("/default/room");
  });

  it("rejects globstar in the middle", () => {
    expect(() => parseSubscribePattern("/default/**/sub")).toThrow(/Globstar.*last segment/);
  });

  it("rejects wildcard in namespace", () => {
    expect(() => parseSubscribePattern("/*/room")).toThrow(/namespace segment/);
    expect(() => parseSubscribePattern("/**")).toThrow(/namespace segment/);
  });

  it("computes channelPrefix as the fixed prefix before wildcard", () => {
    expect(parseSubscribePattern("/default/*").channelPrefix).toBe("/default");
    expect(parseSubscribePattern("/default/room/*/sub").channelPrefix).toBe("/default/room");
  });
});

describe("matchesPattern", () => {
  const p = parseSubscribePattern;
  const c = parsePublishChannel;

  it("matches identical paths", () => {
    expect(matchesPattern(p("/default/room/123"), c("/default/room/123"))).toBe(true);
  });

  it("does not match different namespaces", () => {
    expect(matchesPattern(p("/other/room/*"), c("/default/room/123"))).toBe(false);
  });

  it("matches single-segment wildcard", () => {
    expect(matchesPattern(p("/default/room/*"), c("/default/room/123"))).toBe(true);
    expect(matchesPattern(p("/default/room/*"), c("/default/room/123/sub"))).toBe(false);
    expect(matchesPattern(p("/default/room/*"), c("/default/room"))).toBe(false);
  });

  it("matches globstar across multiple segments", () => {
    expect(matchesPattern(p("/default/room/**"), c("/default/room/1"))).toBe(true);
    expect(matchesPattern(p("/default/room/**"), c("/default/room/1/2"))).toBe(true);
    expect(matchesPattern(p("/default/room/**"), c("/default/room/1/2/3"))).toBe(true);
    expect(matchesPattern(p("/default/room/**"), c("/default/room"))).toBe(false);
    expect(matchesPattern(p("/default/room/**"), c("/default/other/1"))).toBe(false);
  });

  it("matches mixed wildcards", () => {
    expect(matchesPattern(p("/default/*/sub"), c("/default/room/sub"))).toBe(true);
    expect(matchesPattern(p("/default/*/sub"), c("/default/room/other"))).toBe(false);
  });

  it("rejects concrete channel containing wildcards", () => {
    expect(() => matchesPattern(p("/default/*"), p("/default/*"))).toThrow(
      /must not contain wildcards/,
    );
  });
});

describe("candidatePrefixes", () => {
  it("enumerates all prefixes inclusive", () => {
    expect(candidatePrefixes(parsePublishChannel("/a/b/c"))).toEqual(["/a", "/a/b", "/a/b/c"]);
  });
});

describe("property: matchesPattern is consistent with candidatePrefixes", () => {
  // For any subscription pattern that matches a concrete channel,
  // the pattern's channelPrefix must be one of the concrete channel's
  // candidatePrefixes. This is the invariant the DynamoDB lookup relies on.
  it("pattern.channelPrefix is in candidatePrefixes(concrete) when matching", () => {
    const segArb = fc.stringMatching(/^[A-Za-z0-9]([A-Za-z0-9-]{0,5}[A-Za-z0-9])?$/);
    const concreteArb = fc
      .array(segArb, { minLength: 2, maxLength: 5 })
      .map((segs) => `/${segs.join("/")}`);
    const patternSegArb = fc.oneof(segArb, fc.constant("*"));

    fc.assert(
      fc.property(
        concreteArb,
        fc.array(patternSegArb, { minLength: 2, maxLength: 5 }),
        (concretePath, patSegs) => {
          let concrete;
          try {
            concrete = parsePublishChannel(concretePath);
          } catch {
            return; // skip invalid
          }
          // ensure namespace is alphanumeric (no wildcard at index 0)
          patSegs[0] = concrete.namespace;
          const patternPath = `/${patSegs.join("/")}`;
          let pattern;
          try {
            pattern = parseSubscribePattern(patternPath);
          } catch {
            return;
          }
          if (matchesPattern(pattern, concrete)) {
            expect(candidatePrefixes(concrete)).toContain(pattern.channelPrefix);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
