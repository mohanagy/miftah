import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent, AuditFailureMode, AuditHealth, AuditIntegrityOptions, AuditRotationOptions } from "./audit-types.js";
import { appendAuditJournal, prepareAuditJournal } from "./audit-journal.js";
import { SecretRedactor } from "../secrets/redact.js";
import { MiftahError } from "../utils/errors.js";

export interface AuditLoggerOptions {
  secretValues?: readonly string[];
  redactor?: SecretRedactor;
  includeArguments?: boolean;
  failureMode?: AuditFailureMode;
  rotation?: AuditRotationOptions;
  integrity?: AuditIntegrityOptions;
}

export class AuditLogger {
  private static readonly writesByPath = new Map<string, Promise<void>>();
  private readonly options: {
    includeArguments: boolean;
    failureMode: AuditFailureMode;
    rotation?: AuditRotationOptions;
    integrity?: AuditIntegrityOptions;
  };
  private readonly redactor: SecretRedactor;
  private lastFailure?: AuditHealth["lastFailure"];

  constructor(private readonly path: string, options: AuditLoggerOptions = {}) {
    this.options = {
      includeArguments: options.includeArguments ?? false,
      failureMode: options.failureMode ?? "fail-closed",
      rotation: options.rotation,
      integrity: options.integrity
    };
    this.redactor = options.redactor ?? new SecretRedactor();
    this.redactor.addAll(options.secretValues ?? []);
  }

  async log(event: AuditEvent): Promise<void> {
    await this.logWithMode([event], false);
  }

  /** Writes a transition that must be auditable even when ordinary operation logging is configured fail-open. */
  async logRequired(event: AuditEvent): Promise<void> {
    await this.logWithMode([event], true);
  }

  /** Appends related required transitions through one serialized write operation. */
  async logRequiredBatch(events: readonly AuditEvent[]): Promise<void> {
    await this.logWithMode(events, true);
  }

  private async logWithMode(events: readonly AuditEvent[], required: boolean): Promise<void> {
    if (events.length === 0) return;
    const lines = events
      .map((event) => JSON.stringify({ timestamp: new Date().toISOString(), ...this.safeEvent(event) }))
      .join("\n");
    try {
      await this.enqueue(() => this.writeLine(`${lines}\n`));
      this.lastFailure = undefined;
    } catch (error) {
      const failure = this.recordFailure(error);
      if (required || this.options.failureMode === "fail-closed") throw failure;
    }
  }

  private safeEvent(event: AuditEvent): AuditEvent {
    return this.redactor.redactForAudit(
      !this.options.includeArguments
        ? { ...event, arguments: undefined }
        : event
    );
  }

  /** Verifies that a fail-closed sink is writable before an operation can make a side effect. */
  async ensureWritable(): Promise<void> {
    if (this.options.failureMode !== "fail-closed") return;
    try {
      await this.enqueue(() => this.prepareFile());
    } catch (error) {
      throw this.recordFailure(error);
    }
  }

  health(): AuditHealth {
    return this.lastFailure ? { state: "failed", lastFailure: structuredClone(this.lastFailure) } : { state: "healthy" };
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const prior = AuditLogger.writesByPath.get(this.path) ?? Promise.resolve();
    const write = prior.catch(() => undefined).then(operation);
    const tail = write.then(
      () => undefined,
      () => undefined
    );
    AuditLogger.writesByPath.set(this.path, tail);
    void tail.then(() => {
      if (AuditLogger.writesByPath.get(this.path) === tail) AuditLogger.writesByPath.delete(this.path);
    });
    return write;
  }

  private async writeLine(line: string): Promise<void> {
    if (this.options.rotation !== undefined || this.options.integrity !== undefined) {
      await appendAuditJournal(this.path, line, {
        rotation: this.options.rotation,
        integrity: this.options.integrity
      });
      return;
    }
    const file = await this.openAuditFile();
    try {
      await file.writeFile(line, "utf8");
    } finally {
      await file.close();
    }
  }

  private async prepareFile(): Promise<void> {
    if (this.options.rotation !== undefined || this.options.integrity !== undefined) {
      await prepareAuditJournal(this.path, {
        rotation: this.options.rotation,
        integrity: this.options.integrity
      });
      return;
    }
    const file = await this.openAuditFile();
    await file.close();
  }

  private async openAuditFile(): Promise<FileHandle> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(this.path, "a", 0o600);
    try {
      await setRestrictiveMode(this.path, 0o600);
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  private recordFailure(error: unknown): MiftahError {
    const failure = this.asWriteFailure(error);
    this.lastFailure = {
      timestamp: new Date().toISOString(),
      errorCode: "AUDIT_WRITE_FAILED",
      message: failure.message
    };
    return failure;
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
