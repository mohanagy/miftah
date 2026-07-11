import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent, AuditFailureMode, AuditHealth } from "./audit-types.js";
import { SecretRedactor } from "../secrets/redact.js";
import { MiftahError } from "../utils/errors.js";

export interface AuditLoggerOptions {
  secretValues?: readonly string[];
  redactor?: SecretRedactor;
  includeArguments?: boolean;
  failureMode?: AuditFailureMode;
}

export class AuditLogger {
  private static readonly writesByPath = new Map<string, Promise<void>>();
  private readonly options: { includeArguments: boolean; failureMode: AuditFailureMode };
  private readonly redactor: SecretRedactor;
  private lastFailure?: AuditHealth["lastFailure"];

  constructor(private readonly path: string, options: AuditLoggerOptions = {}) {
    this.options = {
      includeArguments: options.includeArguments ?? false,
      failureMode: options.failureMode ?? "fail-closed"
    };
    this.redactor = options.redactor ?? new SecretRedactor();
    this.redactor.addAll(options.secretValues ?? []);
  }

  async log(event: AuditEvent): Promise<void> {
    const safeEvent = this.redactor.redact(
      !this.options.includeArguments
        ? { ...event, arguments: undefined }
        : event
    );
    try {
      await this.enqueue(`${JSON.stringify({ timestamp: new Date().toISOString(), ...safeEvent })}\n`);
      this.lastFailure = undefined;
    } catch (error) {
      const failure = this.asWriteFailure(error);
      this.lastFailure = {
        timestamp: new Date().toISOString(),
        errorCode: "AUDIT_WRITE_FAILED",
        message: failure.message
      };
      if (this.options.failureMode === "fail-closed") throw failure;
    }
  }

  health(): AuditHealth {
    return this.lastFailure ? { state: "failed", lastFailure: structuredClone(this.lastFailure) } : { state: "healthy" };
  }

  private enqueue(line: string): Promise<void> {
    const prior = AuditLogger.writesByPath.get(this.path) ?? Promise.resolve();
    const write = prior.catch(() => undefined).then(() => this.writeLine(line));
    const tail = write.catch(() => undefined);
    AuditLogger.writesByPath.set(this.path, tail);
    void tail.then(() => {
      if (AuditLogger.writesByPath.get(this.path) === tail) AuditLogger.writesByPath.delete(this.path);
    });
    return write;
  }

  private async writeLine(line: string): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await setRestrictiveMode(directory, 0o700);
    const file = await open(this.path, "a", 0o600);
    try {
      await setRestrictiveMode(this.path, 0o600);
      await file.writeFile(line, "utf8");
    } finally {
      await file.close();
    }
  }

  private asWriteFailure(error: unknown): MiftahError {
    const message = this.redactor.redactText(error instanceof Error ? error.message : String(error));
    return new MiftahError("AUDIT_WRITE_FAILED", `AUDIT_WRITE_FAILED: unable to write audit record: ${message}`);
  }
}

async function setRestrictiveMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ENOSYS" && error.code !== "ENOTSUP" && error.code !== "EOPNOTSUPP")
    ) {
      throw error;
    }
  }
}
