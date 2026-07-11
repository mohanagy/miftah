import { describe, expect, it } from "vitest";
import { createRedactor, redactSecrets, redactUri } from "../src/secrets/redact.js";

const opaqueInvalidUriPattern = /^miftah-invalid-uri:[a-f0-9]{64}$/;

describe("secret redaction", () => {
  it("redacts configured secret values in nested data", () => {
    const redact = createRedactor(["super-secret-token"]);
    expect(
      redact({
        token: "super-secret-token",
        message: "Authorization: super-secret-token",
        nested: ["super-secret-token"]
      })
    ).toEqual({
      token: "[REDACTED]",
      message: "Authorization: [REDACTED]",
      nested: ["[REDACTED]"]
    });
  });

  it("redacts secret-looking environment keys", () => {
    expect(redactSecrets({ API_TOKEN: "hidden", ACCOUNT: "work" })).toEqual({
      API_TOKEN: "[REDACTED]",
      ACCOUNT: "work"
    });
  });

  it("redacts plural secret-key variants", () => {
    expect(
      redactSecrets({
        tokens: ["token-value"],
        clientSecrets: ["secret-value"],
        user_passwords: ["password-value"],
        GOOGLE_APPLICATION_CREDENTIALS: "credential-value"
      })
    ).toEqual({
      tokens: "[REDACTED]",
      clientSecrets: "[REDACTED]",
      user_passwords: "[REDACTED]",
      GOOGLE_APPLICATION_CREDENTIALS: "[REDACTED]"
    });
  });

  it("redacts bearer credentials and known provider token formats", () => {
    const bearerToken = ["Bearer", "not-a-real-token-value"].join(" ");
    const cases = [
      { key: "githubClassic", value: "ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCD" },
      { key: "githubPat", value: "github_pat_11ABCDEF_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP" }
    ] as const;

    expect(redactSecrets({ header: bearerToken }).header).toBe(["Bearer", "[REDACTED]"].join(" "));
    for (const testCase of cases) {
      expect(redactSecrets({ [testCase.key]: testCase.value })[testCase.key]).toBe("[REDACTED]");
    }
  });

  it("removes URI userinfo, query values, and fragments from public identifiers", () => {
    expect(
      redactUri(
        "account://resource-uri-user:resource-uri-password@current/path?access_token=resource-uri-secret&state=resource-uri-query-value#resource-uri-fragment"
      )
    ).toBe("account://current/path?access_token=%5BREDACTED%5D&state=%5BREDACTED%5D");
  });

  it("uses stable opaque identifiers for distinct invalid URI values", () => {
    const first = redactUri("/relative/account?access_token=secret-one");
    const second = redactUri("/relative/account?access_token=secret-two");

    expect(first).toMatch(opaqueInvalidUriPattern);
    expect(first).toBe(redactUri("/relative/account?access_token=secret-one"));
    expect(second).toMatch(opaqueInvalidUriPattern);
    expect(second).not.toBe(first);
    expect(first).not.toContain("secret-one");
    expect(second).not.toContain("secret-two");
  });

  it("preserves non-secret identifiers and benign key names", () => {
    const cases = [
      { key: "gitSha", value: "0123456789abcdef0123456789abcdef01234567" },
      { key: "sentryEventId", value: "4c79f60c11214eb38604f4ae0781bfb2" },
      { key: "uuid", value: "550e8400-e29b-41d4-a716-446655440000" },
      { key: "checksum", value: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" },
      { key: "graphqlId", value: "gid://shopify/Product/1234567890" },
      { key: "author", value: "mohanagy" }
    ] as const;

    for (const testCase of cases) {
      expect(redactSecrets({ [testCase.key]: testCase.value })[testCase.key]).toBe(testCase.value);
    }
  });
});
