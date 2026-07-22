import { describe, expect, it } from "vitest";
import { canonicalizeOAuthResource, isCanonicalOAuthResource } from "../src/oauth/canonical-resource.js";

describe("OAuth canonical resource", () => {
  it.each([
    ["HTTPS://Example.TEST:443", "https://example.test"],
    ["https://example.test/", "https://example.test"],
    ["https://EXAMPLE.test:8443/Mcp/%7eClient/%2f", "https://example.test:8443/Mcp/~Client/%2F"],
    ["https://example.test/mcp/", "https://example.test/mcp/"]
  ])("canonicalizes %s without changing meaningful path bytes", (input, expected) => {
    expect(canonicalizeOAuthResource(input)).toBe(expected);
  });

  it.each([
    "http://example.test/mcp",
    "https://user@example.test/mcp",
    "https://example.test/mcp?",
    "https://example.test/mcp?query=value",
    "https://example.test/mcp#fragment",
    "https://example.test/a/./mcp",
    "https://example.test/a/%2e%2E/mcp",
    "https://example.test:0443/mcp",
    "https://127.1/mcp",
    "https://example.test/café"
  ])("rejects an unsafe or ambiguous resource without echoing it", (input) => {
    let failure: unknown;
    try {
      canonicalizeOAuthResource(input);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "OAUTH_RESOURCE_INVALID" });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(input);
  });

  it("distinguishes the canonical serialization from an alias", () => {
    expect(isCanonicalOAuthResource("https://example.test/mcp")).toBe(true);
    expect(isCanonicalOAuthResource("HTTPS://example.test:443/mcp")).toBe(false);
  });
});
