import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAuditExportCommand } from "../src/cli/audit-export.js";
import { AuditLogger } from "../src/audit/audit-logger.js";

async function writeAuditConfig(directory: string, audit: Record<string, unknown> = { path: "audit.jsonl" }): Promise<string> {
  const path = join(directory, "miftah.json");
  await writeFile(
    path,
    JSON.stringify({
      version: "1",
      name: "audit-export-test",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: process.execPath },
      profiles: { default: { env: { API_TOKEN: "secretref:plain://export-secret" } } },
      audit,
      secrets: { allowPlaintextSecrets: true }
    })
  );
  return path;
}

describe("audit export", () => {
  it("re-redacts records and excludes stored arguments by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-export-"));
    const configPath = await writeAuditConfig(directory);
    const auditPath = join(directory, "audit.jsonl");
    const outputPath = join(directory, "support-export.jsonl");
    await writeFile(
      auditPath,
      `${JSON.stringify({
        message: "export-secret",
        callbackUrl: "https://example.test/callback?access_token=uri-secret",
        arguments: { token: "export-secret", safe: "visible" }
      })}\n`
    );

    await runAuditExportCommand({ configPath, outputPath, includeArguments: false });

    const output = await readFile(outputPath, "utf8");
    expect(output).not.toContain("export-secret");
    expect(output).not.toContain("uri-secret");
    expect(JSON.parse(output)).toEqual({
      message: "[REDACTED]",
      callbackUrl: "https://example.test/callback?access_token=%5BREDACTED%5D"
    });
  });

  it("includes only re-redacted stored arguments after explicit opt-in", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-export-arguments-"));
    const configPath = await writeAuditConfig(directory);
    const auditPath = join(directory, "audit.jsonl");
    const outputPath = join(directory, "support-export.jsonl");
    await writeFile(
      auditPath,
      `${JSON.stringify({ arguments: { token: "export-secret", safe: "visible" } })}\n`
    );

    await runAuditExportCommand({ configPath, outputPath, includeArguments: true });

    const output = await readFile(outputPath, "utf8");
    expect(output).not.toContain("export-secret");
    expect(JSON.parse(output)).toEqual({ arguments: { token: "[REDACTED]", safe: "visible" } });
  });

  it("refuses an existing symlink export destination without touching its target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-export-symlink-"));
    const configPath = await writeAuditConfig(directory);
    const auditPath = join(directory, "audit.jsonl");
    const sentinel = join(directory, "outside-sentinel.jsonl");
    const outputPath = join(directory, "support-export.jsonl");
    await writeFile(auditPath, '{"message":"safe"}\n');
    await writeFile(sentinel, "outside data");
    await symlink(sentinel, outputPath);

    await expect(runAuditExportCommand({ configPath, outputPath, includeArguments: false })).rejects.toThrow(
      "Audit export destination already exists."
    );

    expect(await readFile(sentinel, "utf8")).toBe("outside data");
  });

  it("exports retained managed segments in journal order with private output permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-export-rotation-"));
    const configPath = await writeAuditConfig(directory, {
      path: "audit.jsonl",
      rotation: { maxBytes: 1, retainFiles: 4 }
    });
    const auditPath = join(directory, "audit.jsonl");
    const outputPath = join(directory, "support-export.jsonl");
    const logger = new AuditLogger(auditPath, { rotation: { maxBytes: 1, retainFiles: 4 } });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "archived-support-event",
      status: "success",
      durationMs: 1
    });
    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "active-support-event",
      status: "success",
      durationMs: 2
    });

    await runAuditExportCommand({ configPath, outputPath, includeArguments: false });

    expect(
      (await readFile(outputPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { name: string }).name)
    ).toEqual(["archived-support-event", "active-support-event"]);
    if (process.platform !== "win32") expect((await stat(outputPath)).mode & 0o077).toBe(0);
  });

  it("does not create a missing audit parent or disclose it when export cannot read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-export-missing-parent-"));
    const missingParent = join(directory, "private-audit-parent");
    const outputPath = join(directory, "support-export.jsonl");
    const configPath = await writeAuditConfig(directory, { path: "private-audit-parent/events.jsonl" });

    try {
      let failure: unknown;
      try {
        await runAuditExportCommand({ configPath, outputPath, includeArguments: false });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Audit journal is unavailable.");
      expect((failure as Error).message).not.toContain(missingParent);
      await expect(lstat(missingParent)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a redacted cause when export fails after resolving configured secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-export-redacted-cause-"));
    const configPath = await writeAuditConfig(directory);
    const auditPath = join(directory, "audit.jsonl");
    const blockingPath = join(directory, "export-secret-blocker");
    const outputPath = join(blockingPath, "support-export.jsonl");
    await writeFile(auditPath, '{"message":"safe"}\n');
    await writeFile(blockingPath, "not a directory");

    try {
      let failure: unknown;
      try {
        await runAuditExportCommand({ configPath, outputPath, includeArguments: false });
      } catch (error) {
        failure = error;
      }

      if (!(failure instanceof Error) || !(failure.cause instanceof Error)) {
        throw new Error("Expected a redacted export failure cause.");
      }
      const cause = failure.cause as Error & { code?: unknown; path?: unknown };
      expect(failure.message).not.toContain("export-secret");
      expect(cause.message).not.toContain("export-secret");
      expect(cause.stack ?? "").not.toContain("export-secret");
      expect(cause.code).toBe("EEXIST");
      expect(cause.path).toBeDefined();
      expect(String(cause.path)).not.toContain("export-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
