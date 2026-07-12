import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseExternalSecretReference } from "../src/secrets/external-secret-reference.js";
import {
  createKeychainSecretProvider,
  createOnePasswordSecretProvider,
  type SecretCommandDescriptor
} from "../src/secrets/external-secret-providers.js";
import { SecretRedactor } from "../src/secrets/redact.js";
import { SecretProcessError, runSecretCommand } from "../src/secrets/secret-process-runner.js";
import { SecretResolver } from "../src/secrets/secret-resolver.js";
import { MiftahError } from "../src/utils/errors.js";

const testRoot = join(process.cwd(), ".miftah-secret-provider-tests");
const fakeProviderPath = join(process.cwd(), "tests", "fixtures", "fake-secret-provider.mjs");

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

function fakeProviderEnvironment(
  directory: string,
  mode: string,
  value = "fixture-provider-secret"
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    MIFTAH_FAKE_RECORD_PATH: join(directory, "record.json"),
    MIFTAH_FAKE_MODE: mode,
    MIFTAH_FAKE_VALUE: value
  };
}

async function readFakeRecord(directory: string): Promise<{
  argv: string[];
  mode: string;
  hasOpServiceAccountToken: boolean;
  keychainEnvironment: Record<string, string>;
}> {
  return JSON.parse(await readFile(join(directory, "record.json"), "utf8")) as {
    argv: string[];
    mode: string;
    hasOpServiceAccountToken: boolean;
    keychainEnvironment: Record<string, string>;
  };
}

const fakeCommand: SecretCommandDescriptor = {
  executable: process.execPath,
  prefixArgs: [fakeProviderPath]
};

function providerContext(redactor?: SecretRedactor): {
  values: Record<string, string>;
  allowPlaintextSecrets: false;
  registerSecret: (value: string) => void;
} {
  return {
    values: {},
    allowPlaintextSecrets: false,
    registerSecret: (value) => redactor?.add(value)
  };
}

function activePipeCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "PipeWrap").length;
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
});

describe("external secret-reference grammar", () => {
  it("canonicalizes decoded keychain and 1Password components exactly once", () => {
    expect(parseExternalSecretReference("secretref:keychain://service%20name/account%252Fname")).toEqual({
      provider: "keychain",
      service: "service name",
      account: "account%2Fname",
      canonicalReference: "secretref:keychain://service%20name/account%252Fname"
    });
    expect(parseExternalSecretReference("secretref:op://vault%20name/item/field")).toEqual({
      provider: "op",
      vault: "vault name",
      item: "item",
      field: "field",
      canonicalReference: "secretref:op://vault%20name/item/field"
    });
  });

  it.each([
    "secretref:keychain://service%40name/account",
    "secretref:keychain://service%3Fname/account",
    "secretref:keychain://service%23name/account",
    "secretref:keychain://service/account%40name",
    "secretref:keychain://service/account%3Fname",
    "secretref:keychain://service/account%23name",
    "secretref:op://vault%40name/item/field",
    "secretref:op://vault%3Fname/item/field",
    "secretref:op://vault%23name/item/field",
    "secretref:op://vault/item%40name/field",
    "secretref:op://vault/item%3Fname/field",
    "secretref:op://vault/item%23name/field",
    "secretref:op://vault/item/field%40name",
    "secretref:op://vault/item/field%3Fname",
    "secretref:op://vault/item/field%23name"
  ])("rejects percent-encoded reserved delimiters after decoding %s", (reference) => {
    expect(() => parseExternalSecretReference(reference)).toThrow("SECRET_REFERENCE_MALFORMED");
  });
});

describe("secret command runner", () => {
  it("runs argv without a shell and returns bounded stdout", async () => {
        await inSandbox(async (directory) => {
          const result = await runSecretCommand(
            {
              executable: process.execPath,
              args: [fakeProviderPath],
              environment: fakeProviderEnvironment(directory, "success")
            },
            { timeoutMs: 100 }
          );

          expect(result.stdout.toString("utf8")).toBe("fixture-provider-secret");
          expect((await readFakeRecord(directory)).argv).toEqual([]);
        });
  });
});

describe("external secret providers", () => {
        it.each([
          {
            platform: "darwin" as const,
            expectedArgs: ["find-generic-password", "-s", "service;echo shell-sentinel", "-a", "account", "-w"]
          },
          {
            platform: "linux" as const,
            expectedArgs: ["lookup", "service", "service;echo shell-sentinel", "account", "account"]
          }
        ])("uses one shell-free argv element for $platform keychain identifiers", async ({ platform, expectedArgs }) => {
          await inSandbox(async (directory) => {
            const provider = createKeychainSecretProvider({
              platform,
              commands: { [platform]: fakeCommand },
              environment: fakeProviderEnvironment(directory, "success")
            });
            const reference = provider.parse("secretref:keychain://service%3Becho%20shell-sentinel/account");

            await expect(provider.resolve(reference!, providerContext())).resolves.toEqual({ value: "fixture-provider-secret" });
            expect((await readFakeRecord(directory)).argv).toEqual(expectedArgs);
          });
        });

        it("uses a static encoded CredReadW script and per-child Windows environment", async () => {
          await inSandbox(async (directory) => {
            const processEnvironment = { ...process.env };
            const provider = createKeychainSecretProvider({
              platform: "win32",
              commands: { win32: fakeCommand },
              environment: {
                ...fakeProviderEnvironment(directory, "success"),
                OP_SERVICE_ACCOUNT_TOKEN: "keychain-must-not-receive-this-token"
              }
            });
            const service = "windows service";
            const account = "windows account";
            const reference = provider.parse("secretref:keychain://windows%20service/windows%20account");

            await expect(provider.resolve(reference!, providerContext())).resolves.toEqual({ value: "fixture-provider-secret" });

            const record = await readFakeRecord(directory);
            expect(record.argv.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
            const script = Buffer.from(record.argv[3]!, "base64").toString("utf16le");
            expect(script).toContain("CredReadW");
            expect(script).toContain("miftah:keychain:");
            expect(script).toContain("UTF8Encoding");
            expect(script).not.toContain(service);
            expect(script).not.toContain(account);
            expect(record.argv.join(" ")).not.toContain(service);
            expect(record.argv.join(" ")).not.toContain(account);
            expect(record.hasOpServiceAccountToken).toBe(false);
            expect(record.keychainEnvironment).toEqual({
              MIFTAH_KEYCHAIN_SERVICE: encodeURIComponent(service),
              MIFTAH_KEYCHAIN_ACCOUNT: encodeURIComponent(account)
            });
            expect(process.env).toEqual(processEnvironment);
          });
        });

        it("removes exactly one keychain CRLF without trimming valid secret characters", async () => {
          await inSandbox(async (directory) => {
            const value = " leading keychain secret \n";
            const provider = createKeychainSecretProvider({
              platform: "darwin",
              commands: { darwin: fakeCommand },
              environment: fakeProviderEnvironment(directory, "newline", value)
            });
            const reference = provider.parse("secretref:keychain://service/account");

            await expect(provider.resolve(reference!, providerContext())).resolves.toEqual({ value });
          });
        });

        it("reports unavailable keychain platforms and missing binaries with safe errors", async () => {
          const unsupported = createKeychainSecretProvider({ platform: "freebsd" });
          const unavailable = createKeychainSecretProvider({
            platform: "linux",
            commands: { linux: { executable: join(testRoot, "missing-secret-tool") } },
            environment: {}
          });
          const unsupportedError = await rejectedMiftahError(async () =>
            unsupported.resolve(unsupported.parse("secretref:keychain://service/account")!, providerContext())
          );
          const unavailableError = await rejectedMiftahError(async () =>
            unavailable.resolve(unavailable.parse("secretref:keychain://service/account")!, providerContext())
          );

          expect(unsupportedError.code).toBe("SECRET_PROVIDER_UNAVAILABLE");
          expect(unavailableError.code).toBe("SECRET_PROVIDER_UNAVAILABLE");
          expect(`${unsupportedError.message} ${JSON.stringify(unsupportedError.details)}`).not.toContain("missing-secret-tool");
});

it.each([
          ["locked", "SECRET_PROVIDER_LOCKED"],
          ["missing", "SECRET_ITEM_MISSING"],
          ["empty", "SECRET_ITEM_MISSING"],
          ["nul", "SECRET_PROVIDER_FAILED"],
          ["large", "SECRET_PROVIDER_FAILED"],
          ["sleep", "SECRET_PROVIDER_TIMEOUT"]
        ] as const)("maps keychain %s failures without provider output leaks", async (mode, expectedCode) => {
          await inSandbox(async (directory) => {
            const provider = createKeychainSecretProvider({
              platform: "linux",
              commands: { linux: fakeCommand },
              environment: fakeProviderEnvironment(directory, mode, "keychain-secret-that-must-not-leak"),
              timeoutMs: mode === "sleep" ? 20 : undefined
            });
            const error = await rejectedMiftahError(async () =>
              provider.resolve(provider.parse("secretref:keychain://service/account")!, providerContext())
            );

            expect(error.code).toBe(expectedCode);
            expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain("fixture locked raw provider detail");
            expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain("keychain-secret-that-must-not-leak");
          });
        });

        it("distinguishes external cancellation from timeout", async () => {
          const provider = createKeychainSecretProvider({
            platform: "linux",
            commands: { linux: fakeCommand },
            environment: fakeProviderEnvironment(testRoot, "sleep"),
            signal: AbortSignal.abort()
          });
          const error = await rejectedMiftahError(async () =>
            provider.resolve(provider.parse("secretref:keychain://service/account")!, providerContext())
          );

          expect(error.code).toBe("SECRET_PROVIDER_CANCELLED");
        });

        it("requires and redacts a service-account token before noninteractive 1Password execution", async () => {
          await inSandbox(async (directory) => {
            const redactor = new SecretRedactor();
            const token = "op-service-account-token";
            const provider = createOnePasswordSecretProvider({
              command: fakeCommand,
              environment: {
                ...fakeProviderEnvironment(directory, "success", "  op secret  "),
                OP_SERVICE_ACCOUNT_TOKEN: token
              },
              isInteractive: false
            });
            const reference = provider.parse("secretref:op://vault/item/field");

            await expect(provider.resolve(reference!, providerContext(redactor))).resolves.toEqual({ value: "  op secret  " });
            expect((await readFakeRecord(directory)).argv).toEqual(["read", "--no-newline", "op://vault/item/field"]);
            expect((await readFakeRecord(directory)).hasOpServiceAccountToken).toBe(true);
            expect(redactor.redactText(`token=${token}`)).toBe("token=[REDACTED]");
          });
        });

        it("refuses noninteractive 1Password execution without spawning", async () => {
          await inSandbox(async (directory) => {
            const provider = createOnePasswordSecretProvider({
              command: fakeCommand,
              environment: fakeProviderEnvironment(directory, "success"),
              isInteractive: false
            });
            const error = await rejectedMiftahError(async () =>
              provider.resolve(provider.parse("secretref:op://vault/item/field")!, providerContext())
            );

            expect(error.code).toBe("SECRET_PROVIDER_NONINTERACTIVE");
            await expect(readFile(join(directory, "record.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          });
        });

        it("registers the 1Password token before safely reporting a locked vault", async () => {
          await inSandbox(async (directory) => {
            const redactor = new SecretRedactor();
            const token = "op-token-before-locked-vault";
            const provider = createOnePasswordSecretProvider({
              command: fakeCommand,
              environment: {
                ...fakeProviderEnvironment(directory, "locked"),
                OP_SERVICE_ACCOUNT_TOKEN: token
              },
              isInteractive: false
            });
            const error = await rejectedMiftahError(async () =>
              provider.resolve(provider.parse("secretref:op://vault/item/field")!, providerContext(redactor))
            );

            expect(error.code).toBe("SECRET_PROVIDER_LOCKED");
            expect(redactor.redactText(token)).toBe("[REDACTED]");
            expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain("fixture locked raw provider detail");
          });
        });

        it("keeps interactive 1Password calls bounded by the provider timeout", async () => {
          await inSandbox(async (directory) => {
            const provider = createOnePasswordSecretProvider({
              command: fakeCommand,
              environment: fakeProviderEnvironment(directory, "sleep"),
              isInteractive: true,
              timeoutMs: 20
            });
            const error = await rejectedMiftahError(async () =>
              provider.resolve(provider.parse("secretref:op://vault/item/field")!, providerContext())
            );

            expect(error.code).toBe("SECRET_PROVIDER_TIMEOUT");
          });
        });

        describe("external provider resolver integration", () => {
          it("coalesces a canonical keychain reference and registers its value with the shared redactor", async () => {
            await inSandbox(async (directory) => {
              const value = "keychain-value-registered-once";
              const countPath = join(directory, "provider-count.txt");
              const redactor = new SecretRedactor();
              const keychain = createKeychainSecretProvider({
                platform: "linux",
                commands: { linux: fakeCommand },
                environment: {
                  ...fakeProviderEnvironment(directory, "success", value),
                  MIFTAH_FAKE_COUNT_PATH: countPath
                }
              });
              const resolver = new SecretResolver({
                environment: {},
                redactor,
                providers: { keychain }
              });

              await expect(
                Promise.all([
                  resolver.resolveValue("secretref:keychain://service/account"),
                  resolver.resolveValue("secretref:keychain://serv%69ce/account")
                ])
              ).resolves.toEqual([value, value]);
              await expect(readFile(countPath, "utf8")).resolves.toBe("1\n");
              expect(redactor.redactText(`value=${value}`)).toBe("value=[REDACTED]");
            });
          });
});

});

describe("secret command runner", () => {
  it.each([
        ["sleep", { timeoutMs: 20 }, "timeout"],
        ["sleep", { signal: AbortSignal.abort() }, "cancelled"],
        ["large", { timeoutMs: 100 }, "output_limit"]
      ] as const)("reports %s process termination as %s", async (mode, options, expectedKind) => {
        await inSandbox(async (directory) => {
          await expect(
            runSecretCommand(
              {
                executable: process.execPath,
                args: [fakeProviderPath],
                environment: fakeProviderEnvironment(directory, mode)
              },
              options
            )
          ).rejects.toEqual(expect.objectContaining<Partial<SecretProcessError>>({ kind: expectedKind }));
        });
      });

      it("settles a timeout after the direct child exits even when a descendant retains its streams", async () => {
      await inSandbox(async (directory) => {
        const startedAt = Date.now();

        await expect(
          runSecretCommand(
            {
              executable: process.execPath,
              args: [fakeProviderPath],
              environment: fakeProviderEnvironment(directory, "descendant")
            },
            { timeoutMs: 100 }
          )
        ).rejects.toEqual(expect.objectContaining<Partial<SecretProcessError>>({ kind: "timeout" }));

        expect(Date.now() - startedAt).toBeLessThan(250);
      });
      });

  it("settles a timeout after a direct child already exited with retained descendant streams", async () => {
    await inSandbox(async (directory) => {
      const pipesBefore = activePipeCount();
      const startedAt = Date.now();

      await expect(
        runSecretCommand(
          {
            executable: process.execPath,
            args: [fakeProviderPath],
            environment: fakeProviderEnvironment(directory, "early-exit-descendant")
          },
          { timeoutMs: 100 }
        )
      ).rejects.toEqual(expect.objectContaining<Partial<SecretProcessError>>({ kind: "timeout" }));

      expect(Date.now() - startedAt).toBeLessThan(250);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(activePipeCount()).toBeLessThanOrEqual(pipesBefore);
    });
  });
    });

describe("external secret-reference grammar", () => {
  it.each([
        "secretref:keychain:/service/account",
      "secretref:keychain://service",
      "secretref:keychain://service/account/extra",
      "secretref:keychain://service%ZZ/account",
      "secretref:keychain://service%2Fpart/account",
      "secretref:keychain://service%5Cpart/account",
      "secretref:keychain://service%00part/account",
      "secretref:keychain://./account",
      "secretref:keychain://../account",
      "secretref:keychain://user@service/account",
      "secretref:keychain://service/account?query",
      "secretref:keychain://service/account#fragment",
      `secretref:keychain://${"a".repeat(256)}/account`,
      "secretref:op:/vault/item/field",
      "secretref:op://vault/item",
      "secretref:op://vault/item/field/extra",
      "secretref:op://vault/item%0Aname/field"
    ])("rejects unsafe external reference %s", (reference) => {
      expect(() => parseExternalSecretReference(reference)).toThrow("SECRET_REFERENCE_MALFORMED");
  });
});

describe("built-in secret providers", () => {
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

  it("does not alias distinct enabled plaintext values in the resolution cache", async () => {
    const resolver = new SecretResolver({ environment: {}, allowPlaintextSecrets: true });

    await expect(
      resolver.resolveMap({
        first: "secretref:plain://first-plaintext-provider-secret",
        second: "secretref:plain://second-plaintext-provider-secret"
      })
    ).resolves.toEqual({
      first: "first-plaintext-provider-secret",
      second: "second-plaintext-provider-secret"
    });
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
