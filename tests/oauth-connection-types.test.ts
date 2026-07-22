import { describe, expect, it } from "vitest";
import {
  connectionCredentialKey,
  createOAuthConfigIdentity,
  createOAuthConnectionBinding,
  parseOAuthConnectionRef,
  sameOAuthConnectionBinding
} from "../src/oauth/connection-types.js";

const ref = "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5";

function binding(overrides: Record<string, unknown> = {}) {
  return createOAuthConnectionBinding({
    configIdentity: createOAuthConfigIdentity("/tmp/miftah.json"),
    connectionRef: parseOAuthConnectionRef(ref),
    profile: "work",
    upstream: "analytics",
    resource: "https://mcp.example.test/streamable-http",
    issuer: "https://issuer.example.test/oauth",
    clientRegistration: "pre-registered:desktop",
    scopes: ["mcp:tools", "openid"],
    ...overrides
  });
}

describe("OAuth connection binding", () => {
  it("creates a stable credential key across equivalent scope order only", () => {
    const original = binding();
    const reordered = binding({ scopes: ["openid", "mcp:tools"] });

    expect(reordered.scopes).toEqual(["mcp:tools", "openid"]);
    expect(connectionCredentialKey(reordered)).toBe(connectionCredentialKey(original));
    expect(sameOAuthConnectionBinding(reordered, original)).toBe(true);
  });

  it.each([
    ["profile", "personal"],
    ["upstream", "billing"],
    ["resource", "https://mcp.example.test/another-resource"],
    ["issuer", "https://other-issuer.example.test/oauth"],
    ["clientRegistration", "pre-registered:other-client"],
    ["scopes", ["mcp:tools", "profile"]],
    ["connectionRef", "oauthconn:1d915a13-f8a5-45e0-8343-1e82e0939129"],
    ["configIdentity", createOAuthConfigIdentity("/tmp/other-miftah.json")]
  ])("changes credential selection when %s changes", (property, value) => {
    const original = binding();
    const changed = binding({ [property]: value });

    expect(connectionCredentialKey(changed)).not.toBe(connectionCredentialKey(original));
    expect(sameOAuthConnectionBinding(changed, original)).toBe(false);
  });

  it("rejects malformed references and keeps their input out of the stable error message", () => {
    const raw = "oauthconn:not-a-uuid";
    let failure: unknown;
    try {
      parseOAuthConnectionRef(raw);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "OAUTH_CONNECTION_INVALID" });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(raw);
  });

  it.each([
    "http://issuer.example.test/oauth",
    "https://user:password@issuer.example.test/oauth",
    "https://issuer.example.test/oauth?access_token=fixture-token",
    "https://issuer.example.test/oauth#fragment",
    "https:///issuer.example.test/oauth"
  ])("rejects an unsafe or ambiguous issuer binding", (issuer) => {
    let failure: unknown;
    try {
      binding({ issuer });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "OAUTH_CONNECTION_INVALID" });
    expect((failure as Error).message).not.toContain("fixture-token");
  });
});
