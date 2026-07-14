import { describe, expect, it } from "vitest";
import { SecretRedactor, createRedactor, redactSecrets, redactUri } from "../src/secrets/redact.js";

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

  it("shares newly resolved secret values with every later redaction", () => {
    const redactor = new SecretRedactor(["initial-secret"]);

    redactor.add("later-secret");

    expect(
      redactor.redact({
        initial: "initial-secret",
        nested: { later: "prefix later-secret suffix" }
      })
    ).toEqual({
      initial: "[REDACTED]",
      nested: { later: "prefix [REDACTED] suffix" }
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

  it("keeps a long newline-free URI intact until its query values can be redacted", () => {
    const stream = new SecretRedactor().createTextStream();
    const secret = "stream-uri-secret";
    const uriStart = `https://example.test/${"a".repeat(1_100)}`;

    expect(stream.write(`prefix ${uriStart}`)).toBe("");
    expect(stream.write(`?access_token=${secret}`)).toBe("");

    const output = stream.flush();
    expect(output).toContain("prefix ");
    expect(output).not.toContain(secret);
    expect(output).toContain("access_token=%5BREDACTED%5D");
  });

  it("redacts a URI whose arbitrary scheme is split across stream writes", () => {
    const stream = new SecretRedactor().createTextStream();
    const secret = "split-scheme-uri-secret";
    const scheme = `a${"-".repeat(1_100)}`;

    expect(stream.write(scheme)).toBe("");

    const output = [
      stream.write(`://user:password@example.test/path?access_token=${secret}`),
      stream.flush()
    ].join("");

    expect(output).not.toContain("password");
    expect(output).not.toContain(secret);
    expect(output).toContain("access_token=%5BREDACTED%5D");
  });

  it("bounds a long newline-free stream by redacting the complete line", () => {
    const stream = new SecretRedactor().createTextStream();
    const secret = "overlong-uri-secret";
    const uri = `https://example.test/${"a".repeat(8_193)}`;

    const output = [
      stream.write(uri),
      stream.write(`?access_token=${secret}`),
      stream.write(" end\n"),
      stream.flush()
    ].join("");

    expect(output).toBe("[REDACTED STREAM LINE]\n");
    expect(output).not.toContain(secret);
  });

  it("bounds an oversized complete line before forwarding it", () => {
    const stream = new SecretRedactor().createTextStream();

    expect(stream.write(`${"x".repeat(8_193)}\n`)).toBe("[REDACTED STREAM LINE]\n");
  });

  it("fails closed after a capped line can contain a multiline secret prefix", () => {
    const stream = new SecretRedactor(["abc\ndef"]).createTextStream();

    expect(stream.write(`${"x".repeat(8_190)}abc`)).toBe("[REDACTED STREAM LINE]\n");
    expect(stream.write("\ndef\n")).toBe("");
  });

  it("streams stderr with a large configured secret registry", () => {
    const redactor = new SecretRedactor(
      Array.from({ length: 200_000 }, (_, index) => `configured-secret-${index}`)
    );
    const stream = redactor.createTextStream();

    expect(stream.write("diagnostic\n")).toBe("diagnostic\n");
  });

  it("redacts a configured multiline secret split across stream writes", () => {
    const stream = new SecretRedactor(["alpha\nbeta"]).createTextStream();

    expect(stream.write("prefix alpha\n")).toBe("");
    expect(stream.write("beta\n")).toBe("prefix [REDACTED]\n");
  });

  it("redacts a configured secret spanning multiple completed lines", () => {
    const stream = new SecretRedactor(["alpha\nbeta\ngamma"]).createTextStream();

    expect(stream.write("prefix alpha\nbeta\n")).toBe("");
    expect(stream.write("gamma\n")).toBe("prefix [REDACTED]\n");
  });

  it("uses secrets registered before later stream writes", () => {
    const redactor = new SecretRedactor();
    const stream = redactor.createTextStream();

    expect(stream.write("prefix ")).toBe("");
    redactor.add("dynamic-stream-secret");

    expect(stream.write("dynamic-stream-secret\n")).toBe("prefix [REDACTED]\n");
  });

  it("suppresses stderr when a configured secret exceeds the stream cap", () => {
    const stream = new SecretRedactor(["s".repeat(8_193)]).createTextStream();

    expect(stream.write("diagnostic\n")).toBe("[REDACTED STREAM]\n");
    expect(stream.flush()).toBe("");
  });

  it("bounds repeated incomplete multiline-secret prefixes", () => {
    const stream = new SecretRedactor(["a\nb"]).createTextStream();

    expect(stream.write("a\n".repeat(8_193))).toBe("[REDACTED STREAM]\n");
    expect(stream.flush()).toBe("");
  });

  it("suppresses a flush that would exceed the pending stream cap", () => {
    const stream = new SecretRedactor(["a\nb"]).createTextStream();

    expect(stream.write("a\n".repeat(8_192))).toBe("");
    expect(stream.write("x".repeat(8_192))).toBe("");
    expect(stream.flush()).toBe("[REDACTED STREAM]\n");
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
