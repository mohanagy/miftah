import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { AUDIT_RECORD_SCHEMA_VERSION, type AuditEvent } from "../audit/audit-types.js";
import { MiftahError } from "../utils/errors.js";

export interface PosixAnchoredSetupPublication {
  readonly trustedDirectory: {
    readonly path: string;
    readonly identity: string;
  };
  readonly configPath: string;
  readonly configContent: string;
  readonly auditEvent: AuditEvent;
}

interface PublisherResponse {
  readonly ok: boolean;
  readonly stage?: "protocol" | "identity" | "audit" | "config";
  readonly code?: string;
}

const maximumResponseBytes = 8 * 1024;
const maximumRequestBytes = 2 * 1024 * 1024;

/*
 * A separate process gives POSIX setup an inode-anchored working directory:
 * once spawn establishes cwd, renaming that directory cannot redirect the
 * relative config or audit writes. The child verifies cwd's exact identity
 * before accepting any bytes from catalog discovery.
 */
const anchoredPublisherSource = String.raw`
import { constants } from "node:fs";
import { lstat, mkdir, open, rm, stat } from "node:fs/promises";

const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const ownerUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

function codeOf(error) {
  return error !== null && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function ensurePrivateDirectory(path) {
  try {
    await mkdir(path, { mode: privateDirectoryMode });
  } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
  }
  const entry = await lstat(path, { bigint: true });
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    (ownerUid !== undefined && entry.uid !== ownerUid) ||
    (Number(entry.mode) & 0o022) !== 0
  ) {
    throw Object.assign(new Error("unsafe private directory"), { code: "EPERM" });
  }
}

async function openPrivateAuditFile(path) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
    privateFileMode
  );
  try {
    const entry = await handle.stat({ bigint: true });
    if (
      !entry.isFile() ||
      entry.nlink !== 1n ||
      (ownerUid !== undefined && entry.uid !== ownerUid)
    ) {
      throw Object.assign(new Error("unsafe audit file"), { code: "EPERM" });
    }
    await handle.chmod(privateFileMode);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function publishConfig(path, content) {
  let handle;
  let created = false;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      privateFileMode
    );
    created = true;
    const entry = await handle.stat({ bigint: true });
    if (!entry.isFile() || entry.nlink !== 1n || (ownerUid !== undefined && entry.uid !== ownerUid)) {
      throw Object.assign(new Error("unsafe configuration file"), { code: "EPERM" });
    }
    await handle.chmod(privateFileMode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    try {
      await handle?.close();
      if (created) await rm(path, { force: true });
    } catch {
      throw Object.assign(new Error("configuration cleanup failed"), { code: "EIO" });
    }
    throw error;
  }
}

async function run() {
  let encoded = "";
  for await (const chunk of process.stdin) {
    encoded += chunk;
    if (Buffer.byteLength(encoded, "utf8") > ${maximumRequestBytes}) {
      throw Object.assign(new Error("request too large"), { code: "E2BIG", stage: "protocol" });
    }
  }
  let request;
  try {
    request = JSON.parse(encoded);
  } catch {
    throw Object.assign(new Error("invalid request"), { code: "EINVAL", stage: "protocol" });
  }
  if (
    request === null ||
    typeof request !== "object" ||
    typeof request.expectedDirectoryIdentity !== "string" ||
    typeof request.configName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(request.configName) ||
    typeof request.configContent !== "string" ||
    typeof request.auditLine !== "string"
  ) {
    throw Object.assign(new Error("invalid request"), { code: "EINVAL", stage: "protocol" });
  }

  const current = await stat(".", { bigint: true });
  const currentIdentity = String(current.dev) + ":" + String(current.ino);
  if (!current.isDirectory() || currentIdentity !== request.expectedDirectoryIdentity) {
    throw Object.assign(new Error("trusted directory identity changed"), { code: "ESTALE", stage: "identity" });
  }

  let audit;
  try {
    await ensurePrivateDirectory(".miftah");
    await ensurePrivateDirectory(".miftah/audit");
    audit = await openPrivateAuditFile(".miftah/audit/console.jsonl");
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("audit preparation failed"), { stage: "audit" });
  }
  await audit.close();

  try {
    await publishConfig(request.configName, request.configContent);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("configuration publication failed"), { stage: "config" });
  }

  try {
    audit = await openPrivateAuditFile(".miftah/audit/console.jsonl");
    await audit.writeFile(request.auditLine, "utf8");
    await audit.sync();
    await audit.close();
  } catch (error) {
    let closeError;
    try {
      await audit?.close();
    } catch (caught) {
      closeError = caught;
    }
    if (closeError !== undefined) {
      throw Object.assign(
        new AggregateError([error, closeError], "audit append and cleanup failed"),
        { code: "EIO", stage: "audit" }
      );
    }
    throw Object.assign(error instanceof Error ? error : new Error("audit append failed"), { stage: "audit" });
  }
}

try {
  await run();
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    stage: error !== null && typeof error === "object" && typeof error.stage === "string"
      ? error.stage
      : "protocol",
    code: codeOf(error) ?? "EIO"
  }));
  process.exitCode = 1;
}
`;

function publisherResponse(value: unknown): PublisherResponse | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.ok !== "boolean") return undefined;
  if (
    input.stage !== undefined &&
    input.stage !== "protocol" &&
    input.stage !== "identity" &&
    input.stage !== "audit" &&
    input.stage !== "config"
  ) {
    return undefined;
  }
  if (input.code !== undefined && typeof input.code !== "string") return undefined;
  return {
    ok: input.ok,
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.code === undefined ? {} : { code: input.code })
  };
}

function runPublisher(cwd: string, request: string): Promise<PublisherResponse> {
  return new Promise((resolveResponse, rejectResponse) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", anchoredPublisherSource], {
      cwd,
      env: {},
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let stdinError: Error | undefined;

    const reject = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectResponse(error);
    };
    const collect = (destination: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumResponseBytes) {
        reject(new Error("Anchored setup publisher returned too much output."));
        return;
      }
      destination.push(chunk);
    };

    child.once("error", reject);
    child.stdin.once("error", (error) => {
      stdinError = error;
    });
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (stdinError !== undefined && stdout.length === 0) {
        rejectResponse(stdinError);
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        rejectResponse(new Error(`Anchored setup publisher failed with exit code ${String(exitCode)}.`));
        return;
      }
      const response = publisherResponse(decoded);
      if (response === undefined || (exitCode === 0) !== response.ok) {
        rejectResponse(new Error("Anchored setup publisher returned an invalid result."));
        return;
      }
      resolveResponse(response);
    });
    child.stdin.end(request);
  });
}

export async function publishPosixAnchoredSetupConfiguration(
  input: PosixAnchoredSetupPublication
): Promise<void> {
  const trustedDirectory = resolve(input.trustedDirectory.path);
  const configPath = resolve(input.configPath);
  if (
    dirname(configPath) !== trustedDirectory ||
    !/^[0-9]+:[0-9]+$/u.test(input.trustedDirectory.identity)
  ) {
    throw new MiftahError(
      "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE",
      "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE: the trusted configuration directory changed before publication"
    );
  }
  const auditLine = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...input.auditEvent,
    schemaVersion: AUDIT_RECORD_SCHEMA_VERSION
  })}\n`;
  const request = JSON.stringify({
    expectedDirectoryIdentity: input.trustedDirectory.identity,
    configName: basename(configPath),
    configContent: input.configContent,
    auditLine
  });
  if (Buffer.byteLength(request, "utf8") > maximumRequestBytes) {
    throw new MiftahError(
      "CONFIG_CREATE_FAILED",
      "CONFIG_CREATE_FAILED: configuration publication request is too large"
    );
  }

  const response = await runPublisher(trustedDirectory, request).catch((error: unknown) => {
    throw new MiftahError(
      "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE",
      "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE: the trusted configuration directory could not be held for publication",
      { cause: error }
    );
  });
  if (response.ok) return;
  if (response.stage === "identity") {
    throw new MiftahError(
      "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE",
      "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE: the trusted configuration directory changed before publication"
    );
  }
  if (response.stage === "audit") {
    throw new MiftahError(
      "AUDIT_WRITE_FAILED",
      "AUDIT_WRITE_FAILED: unable to write required Console audit record"
    );
  }
  if (response.stage === "config" && response.code === "EEXIST") {
    throw Object.assign(new Error("Configuration file already exists."), { code: "EEXIST" });
  }
  throw new MiftahError(
    "CONFIG_CREATE_FAILED",
    "CONFIG_CREATE_FAILED: unable to create the initial configuration"
  );
}
