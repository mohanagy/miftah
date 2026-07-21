import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join, win32 } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { parseExternalSecretReference } from "../src/secrets/external-secret-reference.js";
import {
  createKeychainSecretProvider,
  createOnePasswordSecretProvider,
  type SecretCommandDescriptor
} from "../src/secrets/external-secret-providers.js";
import { createBuiltinSecretProviders } from "../src/secrets/builtin-secret-providers.js";
import { SecretRedactor } from "../src/secrets/redact.js";
import { SecretProcessError, runSecretCommand } from "../src/secrets/secret-process-runner.js";
import { SecretResolver } from "../src/secrets/secret-resolver.js";
import { MiftahError } from "../src/utils/errors.js";

const testRoot = join(process.cwd(), ".miftah-secret-provider-tests");
const fakeProviderPath = join(process.cwd(), "tests", "fixtures", "fake-secret-provider.mjs");
const embeddedWindowsJobCSharpPattern =
  /const windowsJobHelper = String\.raw`[\s\S]*?\$source = @'\r?\n([\s\S]*?)\r?\n'@\r?\n {2}Add-Type -TypeDefinition \$source/;

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

async function installFakeProviderExecutable(directory: string, name: string): Promise<string> {
  const executable = join(directory, name);
  await copyFile(fakeProviderPath, executable);
  await chmod(executable, 0o700);
  return executable;
}

async function readFakeRecord(directory: string): Promise<{
  argv: string[];
  mode: string;
  hasOpServiceAccountToken: boolean;
  keychainEnvironment: Record<string, string>;
  hasPowerShellModulePath: boolean;
  descendantPid?: number;
}> {
  return JSON.parse(await readFile(join(directory, "record.json"), "utf8")) as {
    argv: string[];
    mode: string;
    hasOpServiceAccountToken: boolean;
    keychainEnvironment: Record<string, string>;
    hasPowerShellModulePath: boolean;
    descendantPid?: number;
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

async function waitForCondition(
  condition: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = process.platform === "win32" ? 1_500 : 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForProviderEntered(providerReadyPath: string, description: string): Promise<void> {
  await waitForCondition(
    async () => {
      try {
        return (await readFile(providerReadyPath, "utf8")) === "provider-entered";
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      }
    },
    description
  );
}

async function readDescendantPid(directory: string): Promise<number> {
  let descendantPid: number | undefined;
  await waitForCondition(async () => {
    try {
      const candidate = (await readFakeRecord(directory)).descendantPid;
      if (!Number.isSafeInteger(candidate) || candidate === undefined || candidate <= 0) return false;
      descendantPid = candidate;
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT" || error instanceof SyntaxError) return false;
      throw error;
    }
  }, "the fake provider to record its descendant PID");
  return descendantPid!;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  await waitForCondition(() => !isProcessRunning(pid), `descendant process ${pid} to exit`);
}

async function terminateTestProcess(pid: number): Promise<void> {
  if (!isProcessRunning(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (errorCode(error) === "ESRCH") return;
    throw error;
  }
  await waitForProcessExit(pid);
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

async function runWindowsCompressedBootstrap(
  source: string,
  environment: NodeJS.ProcessEnv = {},
  standardInput?: Buffer
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const systemRoot = process.env.SystemRoot ?? process.env.windir;
  if (systemRoot === undefined) throw new Error("Windows system root is unavailable");
  const launcher = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const bootstrap = String.raw`$ErrorActionPreference = 'Stop'
$helperName = 'MIFTAH_SECRET_RUNNER_HELPER'
try {
  $encodedHelper = [Environment]::GetEnvironmentVariable($helperName, [EnvironmentVariableTarget]::Process)
  [Environment]::SetEnvironmentVariable($helperName, $null, [EnvironmentVariableTarget]::Process)
  if ([string]::IsNullOrEmpty($encodedHelper) -or $encodedHelper.Length -gt 8192) { exit 1 }
  $input = [IO.MemoryStream]::new([Convert]::FromBase64String($encodedHelper), $false)
  $gzip = [IO.Compression.GzipStream]::new($input, [IO.Compression.CompressionMode]::Decompress, $false)
  $reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
  try {
    $decoded = $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }
  if ([string]::IsNullOrEmpty($decoded)) { exit 1 }
  & ([ScriptBlock]::Create($decoded))
} catch {
  exit 1
}`;
  const encodedBootstrap = Buffer.from(bootstrap, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    const stdin = standardInput === undefined ? "ignore" : "pipe";
    const child = spawn(
      launcher,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedBootstrap],
      {
        env: {
          ...process.env,
          ...environment,
          MIFTAH_SECRET_RUNNER_HELPER: gzipSync(source).toString("base64")
        },
        shell: false,
        windowsHide: true,
        stdio: [stdin, "pipe", "pipe"]
      }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    if (standardInput !== undefined) child.stdin?.end(standardInput);
    child.once("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

async function embeddedWindowsJobCSharp(): Promise<string> {
  const source = await readFile(
    new URL("../src/secrets/windows-secret-command.ts", import.meta.url),
    "utf8"
  );
  const match = source.match(embeddedWindowsJobCSharpPattern);
  if (match?.[1] === undefined) throw new Error("Embedded Windows Job Object C# source is unavailable");
  return match[1];
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

  it("diagnoses the local providers using metadata only", async () => {
    const providers = createBuiltinSecretProviders();
    const availableNames = new Set(["PRESENT"]);
    const environment = providers.environment.parse("secretref:env://PRESENT")!;
    const dotenv = providers.dotenv.parse("secretref:dotenv://MISSING")!;
    const plaintext = providers.plaintext.parse("secretref:plain://diagnostic-value")!;

    await expect(
      providers.environment.diagnose({
        reference: environment,
        availableNames,
        allowPlaintextSecrets: false
      })
    ).resolves.toEqual({ reference: environment, available: true });
    await expect(
      providers.dotenv.diagnose({
        reference: dotenv,
        availableNames,
        allowPlaintextSecrets: false
      })
    ).resolves.toEqual({ reference: dotenv, available: false });
    await expect(
      providers.plaintext.diagnose({
        reference: plaintext,
        availableNames,
        allowPlaintextSecrets: true
      })
    ).resolves.toEqual({ reference: plaintext, available: true });
  });
});

describe("external secret-reference grammar", () => {
  it("leaves non-external values for the remaining resolver providers", () => {
    expect(parseExternalSecretReference("not-a-secret-reference")).toBeUndefined();
  });

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
    expect(parseExternalSecretReference("secretref:keychain://service/%F0%9F%94%90")).toEqual({
      provider: "keychain",
      service: "service",
      account: "🔐",
      canonicalReference: "secretref:keychain://service/%F0%9F%94%90"
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

  it("classifies a genuine lone surrogate as a malformed reference without exposing it", () => {
    const loneSurrogate = JSON.parse('"\\ud800"') as string;
    const reference = `secretref:keychain://${loneSurrogate}/account`;
    let thrown: unknown;

    try {
      parseExternalSecretReference(reference);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MiftahError);
    expect(thrown).not.toBeInstanceOf(URIError);
    expect(thrown).toMatchObject({
      code: "SECRET_REFERENCE_MALFORMED",
      message: "SECRET_REFERENCE_MALFORMED: malformed keychain secret reference",
      details: { provider: "keychain" }
    });
  });
});

describe("secret command runner", () => {
  it.runIf(process.platform === "win32")(
    "observes a cold Node provider entry before its Windows helper settles",
    async () => {
      await inSandbox(async (directory) => {
        const controller = new AbortController();
        const providerReadyPath = join(directory, "provider-ready");
        const pending = runSecretCommand(
          {
            executable: process.execPath,
            args: [fakeProviderPath],
            environment: {
              ...fakeProviderEnvironment(directory, "success"),
              MIFTAH_FAKE_PROVIDER_READY_PATH: providerReadyPath
            }
          },
          { signal: controller.signal }
        );
        let commandSettled = false;
        const observed = pending.then(
          (result) => {
            commandSettled = true;
            return { status: "fulfilled" as const, result };
          },
          (error: unknown) => {
            commandSettled = true;
            return { status: "rejected" as const, error };
          }
        );
        let settlementTimer: NodeJS.Timeout | undefined;

        try {
          await waitForProviderEntered(providerReadyPath, "the cold fake provider to enter through the Windows helper");
          const outcome = await Promise.race([
            observed,
            new Promise<{ status: "pending" }>((resolve) => {
              settlementTimer = setTimeout(() => resolve({ status: "pending" }), 2_000);
            })
          ]);
          if (outcome.status === "pending") {
            throw new Error("The provider entered through the Windows helper but the helper did not settle within 2000ms");
          }
          if (outcome.status === "rejected") throw outcome.error;
          expect(outcome.result.stdout.toString("utf8")).toBe("fixture-provider-secret");
        } finally {
          if (settlementTimer) clearTimeout(settlementTimer);
          if (!commandSettled) controller.abort();
          await observed;
        }
      });
    }
  );

  it.runIf(process.platform === "win32")(
    "retains a cold Node provider entry marker after its Windows helper settles",
    async () => {
      await inSandbox(async (directory) => {
        const controller = new AbortController();
        const providerReadyPath = join(directory, "provider-ready");
        const result = await runSecretCommand(
          {
            executable: process.execPath,
            args: [fakeProviderPath],
            environment: {
              ...fakeProviderEnvironment(directory, "success"),
              MIFTAH_FAKE_PROVIDER_READY_PATH: providerReadyPath
            }
          },
          { signal: controller.signal }
        );

        expect(result.stdout.toString("utf8")).toBe("fixture-provider-secret");
        await expect(readFile(providerReadyPath, "utf8")).resolves.toBe("provider-entered");
      });
    }
  );

  it("runs argv without a shell and returns bounded stdout", async () => {
        await inSandbox(async (directory) => {
          const result = await runSecretCommand(
            {
              executable: process.execPath,
              args: [fakeProviderPath],
              environment: fakeProviderEnvironment(directory, "success")
            },
          );

          expect(result.stdout.toString("utf8")).toBe("fixture-provider-secret");
          expect((await readFakeRecord(directory)).argv).toEqual([]);
        });
  });

  it("rejects input that exceeds the contained command input bound before starting a child", async () => {
    await expect(
      runSecretCommand({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        environment: {},
        stdin: Buffer.alloc(16 * 1024 + 1)
      })
    ).rejects.toEqual(expect.objectContaining({ kind: "input_limit" }));
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

        it.runIf(process.platform !== "win32")(
          "resolves default keychain and 1Password commands from absolute PATH entries",
          async () => {
            await inSandbox(async (directory) => {
              await installFakeProviderExecutable(directory, "secret-tool");
              await installFakeProviderExecutable(directory, "op");
              const environment = {
                ...fakeProviderEnvironment(directory, "success"),
                PATH: `${directory}${delimiter}${process.env.PATH}`,
                OP_SERVICE_ACCOUNT_TOKEN: "default-op-service-token"
              };
              const keychain = createKeychainSecretProvider({ platform: "linux", environment });
              const op = createOnePasswordSecretProvider({ environment, isInteractive: false });

              await expect(
                keychain.resolve(keychain.parse("secretref:keychain://service/account")!, providerContext())
              ).resolves.toEqual({ value: "fixture-provider-secret" });
              await expect(
                op.resolve(op.parse("secretref:op://vault/item/field")!, providerContext())
              ).resolves.toEqual({ value: "fixture-provider-secret" });
              expect((await readFakeRecord(directory)).argv).toEqual(["read", "--no-newline", "op://vault/item/field"]);
            });
          }
        );

        it("fails closed when default external provider executables are unavailable", async () => {
          await inSandbox(async (directory) => {
            const environment = {
              PATH: join(directory, "empty-provider-path"),
              OP_SERVICE_ACCOUNT_TOKEN: "token-for-unavailable-provider"
            };
            const keychain = createKeychainSecretProvider({ platform: "linux", environment });
            const op = createOnePasswordSecretProvider({ environment, isInteractive: false });

            await expect(
              keychain.resolve(keychain.parse("secretref:keychain://service/account")!, providerContext())
            ).rejects.toMatchObject({ code: "SECRET_PROVIDER_UNAVAILABLE" });
            await expect(
              op.resolve(op.parse("secretref:op://vault/item/field")!, providerContext())
            ).rejects.toMatchObject({ code: "SECRET_PROVIDER_UNAVAILABLE" });
          });
        });

        it("diagnoses a missing 1Password executable without resolving its reference", async () => {
          const provider = createOnePasswordSecretProvider({
            environment: { PATH: "/definitely/not/a/provider/bin" }
          });
          const reference = provider.parse("secretref:op://vault/item/field");

          const diagnostic = await provider.diagnose({
            reference: reference!,
            availableNames: new Set(),
            allowPlaintextSecrets: false
          });
          expect(diagnostic.available).toBe(false);
          expect(diagnostic.available).toBe(false);
        });

        it("ignores values that do not belong to an external provider", () => {
          const keychain = createKeychainSecretProvider();
          const op = createOnePasswordSecretProvider();

          expect(keychain.parse("secretref:env://TOKEN")).toBeUndefined();
          expect(op.parse("secretref:keychain://service/account")).toBeUndefined();
        });

        it("uses the process interaction mode when 1Password has no explicit override", async () => {
          await inSandbox(async (directory) => {
            const provider = createOnePasswordSecretProvider({
              command: fakeCommand,
              environment: {
                ...fakeProviderEnvironment(directory, "success"),
                OP_SERVICE_ACCOUNT_TOKEN: "default-interaction-token"
              }
            });

            await expect(
              provider.resolve(provider.parse("secretref:op://vault/item/field")!, providerContext())
            ).resolves.toEqual({ value: "fixture-provider-secret" });
          });
        });

        it.each([
          ["empty", "SECRET_ITEM_MISSING"],
          ["noninteractive", "SECRET_PROVIDER_NONINTERACTIVE"]
        ] as const)("maps 1Password %s output to a stable error", async (mode, expectedCode) => {
          await inSandbox(async (directory) => {
            const provider = createOnePasswordSecretProvider({
              command: fakeCommand,
              environment: fakeProviderEnvironment(directory, mode),
              isInteractive: true
            });

            await expect(
              provider.resolve(provider.parse("secretref:op://vault/item/field")!, providerContext())
            ).rejects.toMatchObject({ code: expectedCode });
          });
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

        it("registers an inherited service-account token before interactive 1Password execution", async () => {
          await inSandbox(async (directory) => {
            const redactor = new SecretRedactor();
            const token = "interactive-op-service-account-token";
            const registeredTokens: string[] = [];
            const environment: NodeJS.ProcessEnv = {
              ...fakeProviderEnvironment(directory, "success", "interactive op secret"),
              MIFTAH_FAKE_REQUIRE_REGISTRATION: "true",
              OP_SERVICE_ACCOUNT_TOKEN: token
            };
            const provider = createOnePasswordSecretProvider({
              command: fakeCommand,
              environment,
              isInteractive: true
            });
            const reference = provider.parse("secretref:op://vault/item/field");
            const context = providerContext(redactor);
            context.registerSecret = (value) => {
              registeredTokens.push(value);
              redactor.add(value);
              environment.MIFTAH_FAKE_REGISTRATION_MARKER = "registered";
            };

            await expect(provider.resolve(reference!, context)).resolves.toEqual({ value: "interactive op secret" });
            expect(registeredTokens).toEqual([token]);
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

        it.runIf(process.platform === "win32")("does not use a current-directory 1Password executable", async () => {
          await inSandbox(async (directory) => {
            const shadowedExecutable = join(directory, "op.exe");
            await copyFile(process.execPath, shadowedExecutable);
            const originalDirectory = process.cwd();
            process.chdir(directory);
            try {
              const provider = createOnePasswordSecretProvider({
                environment: {
                  ...fakeProviderEnvironment(directory, "success"),
                  PATH: join(directory, "empty-path"),
                  OP_SERVICE_ACCOUNT_TOKEN: "shadowed-op-token"
                },
                isInteractive: false
              });
              const error = await rejectedMiftahError(async () =>
                provider.resolve(provider.parse("secretref:op://vault/item/field")!, providerContext())
              );

              expect(error.code).toBe("SECRET_PROVIDER_UNAVAILABLE");
              expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain("shadowed-op-token");
            } finally {
              process.chdir(originalDirectory);
            }
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
  it.runIf(process.platform === "win32")(
    "executes a compressed bootstrap payload before starting providers",
    async () => {
      const result = await runWindowsCompressedBootstrap("Write-Output 'bootstrap-ready'\nexit 0");

      expect(result).toEqual({
        code: 0,
        stdout: "bootstrap-ready\r\n",
        stderr: expect.any(String)
      });
    },
    20_000
  );

  it.runIf(process.platform === "win32")(
    "does not expose parent standard input to the encoded PowerShell bootstrap",
    async () => {
      const input = Buffer.concat([
        Buffer.from("bootstrap-input", "utf8"),
        Buffer.from([0]),
        Buffer.from("with-newline\\n", "utf8")
      ]);
      const result = await runWindowsCompressedBootstrap(
        `$stream = [Console]::OpenStandardInput()
$output = [IO.MemoryStream]::new()
$buffer = [byte[]]::new(4096)
while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
  $output.Write($buffer, 0, $count)
}
[Console]::Out.Write([Convert]::ToBase64String($output.ToArray()))
exit 0`,
        {},
        input
      );

      expect(result).toMatchObject({ code: 0, stdout: "" });
    },
    20_000
  );

  it.runIf(process.platform === "win32")(
    "compiles the embedded Job Object type before starting providers",
    async () => {
      const csharp = await embeddedWindowsJobCSharp();
      const result = await runWindowsCompressedBootstrap(`$ErrorActionPreference = 'Stop'
$source = @'
${csharp}
'@
Add-Type -TypeDefinition $source
Write-Output 'native-type-ready'
exit 0`);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("native-type-ready\r\n");
    },
    60_000
  );

  it.runIf(process.platform === "win32")(
    "runs an immediate cmd.exe child through the embedded Job Object",
    async () => {
      const csharp = await embeddedWindowsJobCSharp();
      const result = await runWindowsCompressedBootstrap(
        `$ErrorActionPreference = 'Stop'
$source = @'
${csharp}
'@
Add-Type -TypeDefinition $source
if (-not [MiftahSecretJob]::Initialize()) { exit 1 }
$exitCode = [MiftahSecretJob]::Run($env:MIFTAH_TEST_EXECUTABLE, [string[]]@('/d', '/s', '/c', 'exit 0'))
Write-Output "native-run-exit=$exitCode"
exit 0`,
        {
          MIFTAH_TEST_EXECUTABLE: win32.join(
            process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
            "System32",
            "cmd.exe"
          )
        }
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("native-run-exit=0\r\n");
    },
    60_000
  );

  it.runIf(process.platform === "win32")(
    "runs an immediate Node child through the embedded Job Object",
    async () => {
      const csharp = await embeddedWindowsJobCSharp();
      const result = await runWindowsCompressedBootstrap(
        `$ErrorActionPreference = 'Stop'
$source = @'
${csharp}
'@
Add-Type -TypeDefinition $source
if (-not [MiftahSecretJob]::Initialize()) { exit 1 }
$exitCode = [MiftahSecretJob]::Run($env:MIFTAH_TEST_EXECUTABLE, [string[]]@('-e', 'process.exit(0)'))
Write-Output "native-run-exit=$exitCode"
exit 0`,
        { MIFTAH_TEST_EXECUTABLE: process.execPath }
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("native-run-exit=0\r\n");
    },
    60_000
  );

  it.runIf(process.platform === "win32")(
    "initializes the embedded Job Object before starting providers",
    async () => {
      const csharp = await embeddedWindowsJobCSharp();
      const result = await runWindowsCompressedBootstrap(`$ErrorActionPreference = 'Stop'
$source = @'
${csharp}
'@
Add-Type -TypeDefinition $source
if (-not [MiftahSecretJob]::Initialize()) { exit 1 }
Write-Output 'native-job-ready'
exit 0`);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("native-job-ready\r\n");
    },
    60_000
  );

  it.runIf(process.platform === "win32")(
    "preserves provider arguments and output through the Job Object helper",
    async () => {
      await inSandbox(async (directory) => {
        const result = await runSecretCommand({
          executable: process.execPath,
          args: [fakeProviderPath, "argument with spaces", "", "trailing\\"],
          environment: fakeProviderEnvironment(directory, "success")
        });

        expect(result.stdout.toString("utf8")).toBe("fixture-provider-secret");
        expect((await readFakeRecord(directory)).argv).toEqual(["argument with spaces", "", "trailing\\"]);
      });
    },
    20_000
  );

  it.runIf(process.platform === "win32")(
    "forwards exact standard input through the Job Object helper to a Node provider",
    async () => {
      const input = Buffer.concat([
        Buffer.from("plugin-host-input", "utf8"),
        Buffer.from([0]),
        Buffer.from("with-newline\\n", "utf8")
      ]);
      const result = await runSecretCommand(
        {
          executable: process.execPath,
          args: [
            "-e",
            'const chunks = []; process.stdin.on("data", (chunk) => chunks.push(chunk)); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ input: Buffer.concat(chunks).toString("base64"), inheritedInput: process.env.MIFTAH_SECRET_RUNNER_STDIN ?? null })));'
          ],
          environment: { PATH: process.env.PATH },
          stdin: input
        },
        { timeoutMs: 10_000 }
      );

      expect(JSON.parse(result.stdout.toString("utf8"))).toEqual({
        input: input.toString("base64"),
        inheritedInput: null
      });
    },
    20_000
  );

  it.runIf(process.platform === "win32")(
    "makes the PowerShell module path available to the Windows provider helper",
    async () => {
      await inSandbox(async (directory) => {
        const result = await runSecretCommand({
          executable: process.execPath,
          args: [fakeProviderPath],
          environment: fakeProviderEnvironment(directory, "success")
        });

        expect(result.stdout.toString("utf8")).toBe("fixture-provider-secret");
        expect((await readFakeRecord(directory)).hasPowerShellModulePath).toBe(true);
      });
    },
    20_000
  );

  it.each([
        ["sleep", { timeoutMs: 20 }, "timeout"],
        ["sleep", { signal: AbortSignal.abort() }, "cancelled"],
        ["large", {}, "output_limit"]
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

  it("classifies a missing executable without retaining its path", async () => {
    await inSandbox(async (directory) => {
      const missingExecutable = join(directory, "missing-provider");

      await expect(
        runSecretCommand({
          executable: missingExecutable,
          args: [],
          environment: {}
        })
      ).rejects.toEqual(expect.objectContaining<Partial<SecretProcessError>>({ kind: "unavailable" }));
    });
  });

  it("bounds stderr before classifying an unsuccessful provider process", async () => {
    await inSandbox(async (directory) => {
      await expect(
        runSecretCommand({
          executable: process.execPath,
          args: [fakeProviderPath],
          environment: fakeProviderEnvironment(directory, "large-stderr")
        })
      ).rejects.toEqual(
        expect.objectContaining<Partial<SecretProcessError>>({ kind: "exit", classification: "other" })
      );
    });
  });

  it.each([
    ["timeout", "timeout"],
    ["cancellation", "cancelled"]
  ] as const)("terminates a spawned descendant when handling %s", async (termination, expectedKind) => {
    await inSandbox(async (directory) => {
      const controller = new AbortController();
      const inheritedSecret = "descendant-secret-that-must-not-leak";
      const mode = termination === "timeout" && process.platform === "win32" ? "slow-descendant" : "descendant";
      const pending = runSecretCommand(
        {
          executable: process.execPath,
          args: [fakeProviderPath],
          environment: fakeProviderEnvironment(directory, mode, inheritedSecret)
        },
        termination === "timeout"
          ? { timeoutMs: process.platform === "win32" ? 2_000 : 200 }
          : { signal: controller.signal }
      );
      const descendantPid = await readDescendantPid(directory);

      try {
        if (termination === "cancellation") controller.abort();
        const error = await pending.then(
          () => {
            throw new Error("Expected secret command to reject");
          },
          (reason: unknown) => reason
        );

        expect(error).toBeInstanceOf(SecretProcessError);
        expect(error).toMatchObject({ kind: expectedKind });
        expect(`${error}`).not.toContain(inheritedSecret);
        await waitForProcessExit(descendantPid);
      } finally {
        await terminateTestProcess(descendantPid);
      }
    });
  });

  it("settles a timeout after the direct child exits even when a descendant retains its streams", async () => {
    await inSandbox(async (directory) => {
      const startedAt = Date.now();
      const timeoutMs = process.platform === "win32" ? 2_000 : 100;

      await expect(
        runSecretCommand(
          {
            executable: process.execPath,
            args: [fakeProviderPath],
            environment: fakeProviderEnvironment(directory, "descendant")
          },
          { timeoutMs }
        )
      ).rejects.toEqual(expect.objectContaining<Partial<SecretProcessError>>({ kind: "timeout" }));

      if (process.platform !== "win32") expect(Date.now() - startedAt).toBeLessThan(250);
    });
  });

  it("settles after a direct child exits with retained descendant streams", async () => {
    await inSandbox(async (directory) => {
      const pipesBefore = activePipeCount();
      const startedAt = Date.now();

      const pending = runSecretCommand(
        {
          executable: process.execPath,
          args: [fakeProviderPath],
          environment: fakeProviderEnvironment(directory, "early-exit-descendant")
        },
        process.platform === "win32" ? {} : { timeoutMs: 100 }
      );
      if (process.platform === "win32") {
        await expect(pending).resolves.toEqual({ stdout: Buffer.alloc(0) });
      } else {
        await expect(pending).rejects.toEqual(expect.objectContaining<Partial<SecretProcessError>>({ kind: "timeout" }));
      }

      if (process.platform !== "win32") expect(Date.now() - startedAt).toBeLessThan(250);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(activePipeCount()).toBeLessThanOrEqual(pipesBefore);
    });
  });

  it.runIf(process.platform !== "win32")(
    "force-kills a retained descendant after its direct provider exits",
    async () => {
      await inSandbox(async (directory) => {
        const readyPath = join(directory, "descendant-ready");
        const signalPath = join(directory, "descendant-signal");
        const pending = runSecretCommand(
          {
            executable: process.execPath,
            args: [fakeProviderPath],
            environment: {
              ...fakeProviderEnvironment(directory, "early-exit-stubborn-descendant"),
              MIFTAH_FAKE_DESCENDANT_READY_PATH: readyPath,
              MIFTAH_FAKE_DESCENDANT_SIGNAL_PATH: signalPath
            }
          },
          { timeoutMs: 1_000 }
        );
        const descendantPid = await readDescendantPid(directory);

        try {
          await waitForCondition(
            async () => {
              try {
                return (await readFile(readyPath, "utf8")) === "ready";
              } catch (error) {
                if (errorCode(error) === "ENOENT") return false;
                throw error;
              }
            },
            "stubborn descendant to start",
            500
          );

          await expect(pending).rejects.toEqual(expect.objectContaining<Partial<SecretProcessError>>({ kind: "timeout" }));
          await expect(readFile(signalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          await waitForProcessExit(descendantPid);
        } finally {
          await terminateTestProcess(descendantPid);
        }
      });
    }
  );

  it.runIf(process.platform === "win32")(
    "closes an orphaned descendant when its direct provider process exits",
    async () => {
      await inSandbox(async (directory) => {
        const providerReadyPath = join(directory, "provider-ready");
        const pending = runSecretCommand(
          {
            executable: process.execPath,
            args: [fakeProviderPath],
            environment: {
              ...fakeProviderEnvironment(directory, "early-exit-descendant"),
              MIFTAH_FAKE_PROVIDER_READY_PATH: providerReadyPath
            }
          }
        );
        await waitForProviderEntered(providerReadyPath, "the fake provider to enter before recording its descendant PID");
        const descendantPid = await readDescendantPid(directory);

        try {
          await expect(pending).resolves.toEqual({ stdout: Buffer.alloc(0) });
          await waitForProcessExit(descendantPid);
        } finally {
          await terminateTestProcess(descendantPid);
        }
      });
    }
  );
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
      "secretref:keychain://service%C2%80part/account",
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
