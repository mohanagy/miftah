import { describe, expect, it } from "vitest";
import { redactSecrets, createRedactor } from "../src/secrets/redact.js";

describe("secret redaction", () => {
  it("redacts configured values in nested data and token-like strings", () => {
    const redact = createRedactor(["super-secret-token"]);
    expect(
      redact({
        token: "super-secret-token",
        message: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
        nested: ["super-secret-token"]
      })
    ).toEqual({
      token: "[REDACTED]",
      message: "Authorization: Bearer [REDACTED]",
      nested: ["[REDACTED]"]
    });
  });

  it("redacts secret-looking environment keys", () => {
    expect(redactSecrets({ API_TOKEN: "hidden", ACCOUNT: "work" })).toEqual({
      API_TOKEN: "[REDACTED]",
      ACCOUNT: "work"
    });
  });
});
