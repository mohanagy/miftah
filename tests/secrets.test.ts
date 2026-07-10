import { describe, expect, it } from "vitest";
import { createRedactor, redactSecrets } from "../src/secrets/redact.js";

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
