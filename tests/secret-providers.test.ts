import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SecretRedactor } from "../src/secrets/redact.js";
import { SecretResolver } from "../src/secrets/secret-resolver.js";
import { MiftahError } from "../src/utils/errors.js";

const testRoot = join(process.cwd(), ".miftah-secret-provider-tests");

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function inSandbox<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = join(testRoot, randomUUID());
  await mkdir(directory, { recursive: true });
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function rejectedMiftahError(operation: () => Promise<unknown>): Promise<MiftahError> {
  return operation().then(
    () => {
      throw new Error("Expected secret resolution to reject");
    },
    (error: unknown) => {
      if (error instanceof MiftahError) return error;
      throw error;
    }
  );
}

describe("built-in secret providers", () => {
  it("resolves environment, dotenv, and interpolated references asynchronously with precedence", async () => {
    await inSandbox(async (directory) => {
      const firstEnvFile = join(directory, "first.env");
      const secondEnvFile = join(directory, "second.env");
      const redactor = new SecretRedactor();
      await writeFile(firstEnvFile, "SHARED=from-first-dotenv\nDOTENV_ONLY=from-first-dotenv\n");
      await writeFile(secondEnvFile, "DOTENV_ONLY=from-second-dotenv\n");

      const resolver = new SecretResolver({
        environment: { SHARED: "from-process", EMBEDDED: "embedded-secret" },
        envFiles: [firstEnvFile, secondEnvFile],
        redactor
      });
      await resolver.load();

      const pending = resolver.resolveMap({
        environment: "secretref:env://SHARED",
        dotenv: "secretref:dotenv://DOTENV_ONLY",
        interpolation: "prefix-${EMBEDDED}-suffix"
      });

      expect(pending).toBeInstanceOf(Promise);
      await expect(pending).resolves.toEqual({
        environment: "from-process",
        dotenv: "from-first-dotenv",
        interpolation: "prefix-embedded-secret-suffix"
      });
      expect(
        redactor.redactText(
          "from-process from-first-dotenv prefix-embedded-secret-suffix embedded-secret"
        )
      ).toBe("[REDACTED] [REDACTED] prefix-[REDACTED]-suffix [REDACTED]");
    });
  });

  it("resolves explicitly enabled plaintext references asynchronously and registers them", async () => {
    const redactor = new SecretRedactor();
    const resolver = new SecretResolver({
      environment: {},
      allowPlaintextSecrets: true,
      redactor
    });

    const pending = resolver.resolveValue("secretref:plain://plaintext-provider-secret");

    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toBe("plaintext-provider-secret");
    expect(redactor.redactText("value=plaintext-provider-secret")).toBe("value=[REDACTED]");
  });

  it("rejects disabled plaintext references without exposing their payload", async () => {
    const secret = "disabled-plaintext-provider-secret";
    const error = await rejectedMiftahError(async () =>
      new SecretResolver({ environment: {} }).resolveValue(`secretref:plain://${secret}`)
    );

    expect(error.code).toBe("SECRET_PROVIDER_FAILED");
    expect(error.message).toContain("secretref:plain://[REDACTED]");
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain(secret);
  });

  it("rejects unknown providers without exposing their payload", async () => {
    const secret = "unknown-provider-secret";
    const error = await rejectedMiftahError(async () =>
      new SecretResolver({ environment: {} }).resolveValue(`secretref:unknown://${secret}`)
    );

    expect(error.code).toBe("SECRET_PROVIDER_FAILED");
    expect(error.message).toContain("secretref:unknown://");
    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain(secret);
  });
});
