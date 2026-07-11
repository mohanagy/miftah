import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEvent } from "./audit-types.js";
import { redactSecrets } from "../secrets/redact.js";

export class AuditLogger {
  private readonly options: { secretValues: readonly string[]; includeArguments: boolean };

  constructor(
    private readonly path: string,
    options: { secretValues?: readonly string[]; includeArguments?: boolean } = {}
  ) {
    this.options = {
      secretValues: options.secretValues ?? [],
      includeArguments: options.includeArguments ?? false
    };
  }

  async log(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const safeEvent = redactSecrets(
      !this.options.includeArguments
        ? { ...event, arguments: undefined }
        : event,
      this.options.secretValues ?? []
    );
    await appendFile(this.path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...safeEvent })}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }
}
