import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { delimiter, join, win32 } from "node:path";
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
const posixDescendantProviderFixturePath = join(
  process.cwd(),
  "tests",
  "fixtures",
  "posix-descendant-provider.sh"
);
const realSetTimeout = globalThis.setTimeout;

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

async function installPosixDescendantProviderExecutable(directory: string): Promise<string> {
  const executable = join(directory, "posix-descendant-provider");
  await copyFile(posixDescendantProviderFixturePath, executable);
  await chmod(executable, 0o700);
  return executable;
}

async function readFakeRecord(directory: string): Promise<{
  argv: string[];
  mode: string;
  hasOpServiceAccountToken: boolean;
  keychainEnvironment: Record<string, string>;
  hasPowerShellModulePath: boolean;
  providerPid?: number;
  descendantPid?: number;
}> {
  return JSON.parse(await readFile(join(directory, "record.json"), "utf8")) as {
    argv: string[];
    mode: string;
    hasOpServiceAccountToken: boolean;
    keychainEnvironment: Record<string, string>;
    hasPowerShellModulePath: boolean;
    providerPid?: number;
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

async function waitForProviderEntered(
  providerReadyPath: string,
  description: string,
  timeoutMs?: number
): Promise<void> {
  await waitForCondition(
    async () => {
      try {
        return (await readFile(providerReadyPath, "utf8")) === "provider-entered";
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      }
    },
    description,
    timeoutMs
  );
}

async function createProviderReadinessBarrier(): Promise<{
  server: Server;
  port: number;
  reached: Promise<void>;
  release: () => void;
  close: () => Promise<void>;
}> {
  let resolveReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  let fixtureSocket: Socket | undefined;
  const server = createServer((socket) => {
    if (fixtureSocket !== undefined) {
      socket.destroy();
      return;
    }
    fixtureSocket = socket;
    socket.once("error", () => undefined);
    resolveReached();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      server.on("error", () => undefined);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    throw new Error("Expected readiness barrier to listen on a TCP port");
  }

  return {
    server,
    port: address.port,
    reached,
    release: () => fixtureSocket?.end("release"),
    close: async () => {
      fixtureSocket?.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

async function readDescendantPid(directory: string): Promise<number> {
  return readDescendantPidWithWait(directory, waitForCondition);
}

async function readDescendantPidWithWait(
  directory: string,
  wait: (
    condition: () => Promise<boolean> | boolean,
    description: string,
    timeoutMs?: number
  ) => Promise<void>
): Promise<number> {
  let descendantPid: number | undefined;
  await wait(async () => {
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

async function readPosixProcessIds(
  directory: string,
  observed: Promise<unknown>
): Promise<{ providerPid: number; descendantPid: number }> {
  let commandSettled = false;
  void observed.then(() => {
    commandSettled = true;
  });
  for (;;) {
    try {
      const record = await readFakeRecord(directory);
      if (
        Number.isSafeInteger(record.providerPid) &&
        record.providerPid !== undefined &&
        record.providerPid > 0 &&
        Number.isSafeInteger(record.descendantPid) &&
        record.descendantPid !== undefined &&
        record.descendantPid > 0
      ) {
        return { providerPid: record.providerPid, descendantPid: record.descendantPid };
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (commandSettled) throw new Error("Provider command settled before recording its process IDs");
    await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  }
}

async function readPosixDescendantPid(directory: string, observed: Promise<unknown>): Promise<number> {
  return (await readPosixProcessIds(directory, observed)).descendantPid;
}

async function waitForPosixCondition(
  condition: () => Promise<boolean> | boolean,
  observed: Promise<unknown>,
  description: string
): Promise<void> {
  let commandSettled = false;
  void observed.then(() => {
    commandSettled = true;
  });
  for (;;) {
    if (await condition()) return;
    if (commandSettled) throw new Error(`Provider command settled before ${description}`);
    await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  }
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

function observeCommand<T>(pending: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

/** Test-only gate for the initial runner deadline; later termination timers remain real. */
function holdNextTimeout(timeoutMs: number): { restore: () => void; trigger: () => void } {
  const originalSetTimeout = globalThis.setTimeout;
  let heldCallback: (() => void) | undefined;
  const heldSetTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (heldCallback === undefined && delay === timeoutMs) {
      heldCallback = () => handler(...args);
      const inertTimer = originalSetTimeout(() => undefined, 0);
      globalThis.clearTimeout(inertTimer);
      return inertTimer;
    }
    return originalSetTimeout(handler as (...args: never[]) => void, delay, ...(args as never[]));
  }) as typeof globalThis.setTimeout;
  globalThis.setTimeout = heldSetTimeout;

  return {
    restore: () => {
      globalThis.setTimeout = originalSetTimeout;
    },
    trigger: () => {
      const callback = heldCallback;
      heldCallback = undefined;
      if (callback === undefined) throw new Error("Expected secret command to schedule its timeout");
      callback();
    }
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

async function runWindowsJobExecutable(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  standardInput?: Buffer
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const encodedRequest = encodeWindowsJobRequest(executable, args);

  return new Promise((resolve, reject) => {
    const child = spawn(
      join(process.cwd(), "assets", "windows-secret-job.exe"),
      [],
      {
        env: {
          ...process.env,
          ...environment,
          MIFTAH_SECRET_RUNNER_REQUEST: encodedRequest,
          ...(standardInput === undefined
            ? {}
            : { MIFTAH_SECRET_RUNNER_STDIN: standardInput.toString("base64") })
        },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function encodeWindowsJobRequest(executable: string, args: readonly string[]): string {
  const executableBytes = Buffer.from(executable, "utf8");
  const argumentBytes = args.map((argument) => Buffer.from(argument, "utf8"));
  const length =
    1 + 4 + executableBytes.length + 4 + argumentBytes.reduce((total, argument) => total + 4 + argument.length, 0);
  const request = Buffer.allocUnsafe(length);
  let offset = 0;
  request.writeUInt8(1, offset++);
  request.writeInt32LE(executableBytes.length, offset);
  offset += 4;
  executableBytes.copy(request, offset);
  offset += executableBytes.length;
  request.writeInt32LE(argumentBytes.length, offset);
  offset += 4;
  for (const argument of argumentBytes) {
    request.writeInt32LE(argument.length, offset);
    offset += 4;
    argument.copy(request, offset);
    offset += argument.length;
  }
  return request.toString("base64");
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
  it("keeps provider readiness-barrier server errors handled after startup", async () => {
    const barrier = await createProviderReadinessBarrier();
    try {
      expect(() => barrier.server.emit("error", new Error("test readiness barrier error"))).not.toThrow();
    } finally {
      await barrier.close();
    }
  });

  it.runIf(process.platform === "win32")(
    "keeps a cold Node provider pending at a readiness barrier through its Windows helper",
    async () => {
      await inSandbox(async (directory) => {
        const controller = new AbortController();
        const barrier = await createProviderReadinessBarrier();
        const providerReadyPath = join(directory, "provider-ready");
        // Keep every observation plus failure cleanup inside the existing 5s test limit.
        const diagnosticDeadline = Date.now() + 3_750;
        const remainingDiagnosticTime = () => Math.max(1, diagnosticDeadline - Date.now());
        const pending = runSecretCommand(
          {
            executable: process.execPath,
            args: [fakeProviderPath, "readiness-barrier-argument"],
            environment: {
              ...fakeProviderEnvironment(directory, "success"),
              MIFTAH_FAKE_PROVIDER_BARRIER_PORT: `${barrier.port}`,
              MIFTAH_FAKE_PROVIDER_READY_PATH: providerReadyPath
            }
          },
          { signal: controller.signal }
        );
        let settled = false;
        let settlementError: unknown;
        const settlement = pending.then(
          () => {
            settled = true;
            return "settled" as const;
          },
          (error: unknown) => {
            settled = true;
            settlementError = error;
            return "settled" as const;
          }
        );
        const prematureSettlement = (message: string) =>
          settlementError === undefined ? new Error(message) : new Error(message, { cause: settlementError });
        let barrierReached = false;
        void barrier.reached.then(() => {
          barrierReached = true;
        });

        let diagnosticFailure: unknown;
        try {
          const entry = await Promise.race([
            waitForProviderEntered(
              providerReadyPath,
              "the cold fake provider to enter through the Windows helper",
              remainingDiagnosticTime()
            ).then(() => "entered" as const),
            settlement
          ]);
          if (entry !== "entered") {
            throw prematureSettlement(
              "The cold provider command settled before the fake provider entered through the Windows helper"
            );
          }
          expect(settled).toBe(false);

          await waitForCondition(
            () => barrierReached || settled,
            "the entered fake provider to reach its readiness barrier",
            remainingDiagnosticTime()
          );
          if (!barrierReached) {
            throw prematureSettlement(
              "The cold fake provider entered through the Windows helper but settled before its readiness barrier"
            );
          }
          expect(settled).toBe(false);

          barrier.release();
          await waitForCondition(
            () => settled,
            "the released cold provider command to settle through the Windows helper",
            remainingDiagnosticTime()
          );
          const result = await pending;
          expect(result.stdout.toString("utf8")).toBe("fixture-provider-secret");
          await expect(readFakeRecord(directory)).resolves.toMatchObject({
            argv: ["readiness-barrier-argument"]
          });
        } catch (error) {
          diagnosticFailure = error;
        }

        let cleanupFailure: unknown;
        try {
          if (!settled) controller.abort();
          await barrier.close();
          if (!settled) {
            await waitForCondition(
              () => settled,
              "the aborted cold provider command to settle through the Windows helper",
              500
            );
          }
        } catch (error) {
          cleanupFailure = error;
        }

        if (diagnosticFailure !== undefined && cleanupFailure !== undefined) {
          throw new AggregateError(
            [diagnosticFailure, cleanupFailure],
            "Cold Windows provider diagnostic and cleanup both failed"
          );
        }
        if (diagnosticFailure !== undefined) throw diagnosticFailure;
        if (cleanupFailure !== undefined) throw cleanupFailure;
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
            await writeFile(shadowedExecutable, "", { mode: 0o700 });
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
    "runs an immediate cmd.exe child through the direct Job Object executable",
    async () => {
      const result = await runWindowsJobExecutable(
        win32.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", "cmd.exe"),
        ["/d", "/s", "/c", "exit 0"]
      );

      expect(result).toEqual({
        code: 0,
        stdout: "",
        stderr: expect.any(String)
      });
    },
    20_000
  );

  it.runIf(process.platform === "win32")(
    "runs an immediate Node child through the direct Job Object executable",
    async () => {
      const result = await runWindowsJobExecutable(
        process.execPath,
        ["-e", "process.stdout.write('native-node-ready')"]
      );

      expect(result).toMatchObject({ code: 0, stdout: "native-node-ready" });
    },
    20_000
  );

  it.runIf(process.platform === "win32")(
    "keeps the parent standard handles usable across direct helper executions",
    async () => {
      const first = await runWindowsJobExecutable(process.execPath, ["-e", "process.exit(0)"]);
      const second = await runWindowsJobExecutable(process.execPath, ["-e", "process.exit(0)"]);

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
    },
    20_000
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
      const executable =
        process.platform === "win32" ? process.execPath : await installPosixDescendantProviderExecutable(directory);
      const args = process.platform === "win32" ? [fakeProviderPath] : [];
      const timeoutMs = process.platform === "win32" ? 2_000 : 200;
      const timeoutGate = termination === "timeout" && process.platform !== "win32" ? holdNextTimeout(timeoutMs) : undefined;
      let timeoutTriggered = false;
      let pending: Promise<{ stdout: Buffer }>;
      try {
        pending = runSecretCommand(
          {
            executable,
            args,
            environment: fakeProviderEnvironment(directory, mode, inheritedSecret)
          },
          termination === "timeout" ? { timeoutMs } : { signal: controller.signal }
        );
      } finally {
        timeoutGate?.restore();
      }
      const observed = observeCommand(pending);
      let descendantPid: number | undefined;

      try {
        descendantPid =
          process.platform === "win32"
            ? await readDescendantPid(directory)
            : await readPosixDescendantPid(directory, observed);
        if (termination === "cancellation") controller.abort();
        if (timeoutGate !== undefined) {
          timeoutGate.trigger();
          timeoutTriggered = true;
        }
        const outcome = await observed;
        if ("value" in outcome) throw new Error("Expected secret command to reject");
        const { error } = outcome;

        expect(error).toBeInstanceOf(SecretProcessError);
        expect(error).toMatchObject({ kind: expectedKind });
        expect(`${error}`).not.toContain(inheritedSecret);
        await waitForProcessExit(descendantPid);
      } finally {
        if (termination === "cancellation") controller.abort();
        timeoutGate?.restore();
        if (!timeoutTriggered) {
          timeoutGate?.trigger();
        }
        await observed;
        if (descendantPid !== undefined) await terminateTestProcess(descendantPid);
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
        const executable = await installPosixDescendantProviderExecutable(directory);
        const timeoutGate = holdNextTimeout(1_000);
        let timeoutTriggered = false;
        let pending: Promise<{ stdout: Buffer }>;
        try {
          pending = runSecretCommand(
            {
              executable,
              args: [],
              environment: {
                ...fakeProviderEnvironment(directory, "early-exit-stubborn-descendant"),
                MIFTAH_FAKE_DESCENDANT_READY_PATH: readyPath,
                MIFTAH_FAKE_DESCENDANT_SIGNAL_PATH: signalPath
              }
            },
            { timeoutMs: 1_000 }
          );
        } finally {
          timeoutGate.restore();
        }
        const observed = observeCommand(pending);
        let descendantPid: number | undefined;

        try {
          const processIds = await readPosixProcessIds(directory, observed);
          descendantPid = processIds.descendantPid;
          await waitForPosixCondition(
            async () => {
              try {
                return (await readFile(readyPath, "utf8")) === "ready";
              } catch (error) {
                if (errorCode(error) === "ENOENT") return false;
                throw error;
              }
            },
            observed,
            "the stubborn descendant to start"
          );
          await waitForProcessExit(processIds.providerPid);
          await new Promise<void>((resolve) => setImmediate(resolve));

          timeoutGate.trigger();
          timeoutTriggered = true;
          const outcome = await observed;
          if ("value" in outcome) throw new Error("Expected secret command to reject");
          expect(outcome.error).toEqual(expect.objectContaining<Partial<SecretProcessError>>({ kind: "timeout" }));
          await expect(readFile(signalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          await waitForProcessExit(descendantPid);
        } finally {
          timeoutGate.restore();
          if (!timeoutTriggered) {
            timeoutGate.trigger();
          }
          await observed;
          if (descendantPid !== undefined) await terminateTestProcess(descendantPid);
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
