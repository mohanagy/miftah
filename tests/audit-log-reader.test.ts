import { truncateSync, writeFileSync } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import {
  AUDIT_READ_CHUNK_BYTES,
  MALFORMED_AUDIT_RECORD,
  MAX_INCOMPLETE_AUDIT_RECORD_BYTES,
  followAuditJsonl,
  readAuditJsonl
} from "../src/cli/audit-jsonl.js";
import { runLogsCommand } from "../src/cli/logs.js";
import { createRuntime } from "../src/runtime/create-runtime.js";
import { resolveRuntimeConfig } from "../src/runtime/resolve-runtime-config.js";
import { SecretRedactor } from "../src/secrets/redact.js";

const testRoot = join(process.cwd(), ".miftah-audit-log-reader-tests");
const pollIntervalMs = 10;

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

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms`);
    await delay(pollIntervalMs);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function namedUpstreamConfig(auditPath: string) {
  return {
    version: "1",
    name: "audit-log-reader",
    defaultProfile: "default",
    upstreams: {
      primary: {
        transport: "stdio",
        command: process.execPath,
        env: { UPSTREAM_ENV: "secretref:plain://named-upstream-env" },
        headers: { Authorization: "secretref:plain://named-upstream-header" }
      }
    },
    profiles: {
      default: {
        env: { DEFAULT_ENV: "secretref:plain://default-profile-env" },
        headers: { "x-default": "secretref:plain://default-profile-header" }
      },
      work: {
        env: { WORK_ENV: "secretref:plain://non-default-profile-env" },
        headers: { "x-work": "secretref:plain://non-default-profile-header" },
        upstreams: {
          primary: {
            env: { WORK_UPSTREAM_ENV: "secretref:plain://profile-upstream-env" },
            headers: { "x-work-upstream": "secretref:plain://profile-upstream-header" }
          }
        }
      }
    },
    audit: { path: auditPath },
    secrets: { allowPlaintextSecrets: true }
  };
}

describe("runtime configuration resolution", () => {
  it("shares resolved secrets from all profile and named-upstream maps without starting a manager", async () => {
    await inSandbox(async (directory) => {
      const configPath = join(directory, "miftah.json");
      await writeJson(configPath, namedUpstreamConfig("audit.jsonl"));

      const resolved = await resolveRuntimeConfig(configPath);

      expect(resolved.config.profiles.work).toMatchObject({
        env: { WORK_ENV: "non-default-profile-env" },
        headers: { "x-work": "non-default-profile-header" },
        upstreams: {
          primary: {
            env: { WORK_UPSTREAM_ENV: "profile-upstream-env" },
            headers: { "x-work-upstream": "profile-upstream-header" }
          }
        }
      });
      expect(resolved.config.upstreams?.primary).toMatchObject({
        env: { UPSTREAM_ENV: "named-upstream-env" },
        headers: { Authorization: "named-upstream-header" }
      });
      expect(resolved.redactor.redactForAudit({ message: "non-default-profile-env" })).toEqual({
        message: "[REDACTED]"
      });
      expect(resolved.redactor.redactForAudit({ message: "profile-upstream-header" })).toEqual({
        message: "[REDACTED]"
      });

      const runtime = await createRuntime(configPath);
      try {
        expect(runtime.config).toEqual(resolved.config);
        expect(runtime.redactor.redactForAudit({ message: "named-upstream-header" })).toEqual({
          message: "[REDACTED]"
        });
      } finally {
        await runtime.manager.close();
      }
    });
  });

  it("resolves single-upstream maps and retains their secrets for redaction", async () => {
    await inSandbox(async (directory) => {
      const configPath = join(directory, "miftah.json");
      await writeJson(configPath, {
        version: "1",
        name: "single-upstream",
        defaultProfile: "default",
        upstream: {
          transport: "stdio",
          command: process.execPath,
          env: { SINGLE_ENV: "secretref:plain://single-upstream-env" },
          headers: { Authorization: "secretref:plain://single-upstream-header" }
        },
        profiles: { default: {} },
        secrets: { allowPlaintextSecrets: true }
      });

      const resolved = await resolveRuntimeConfig(configPath);

      expect(resolved.upstream).toMatchObject({
        env: { SINGLE_ENV: "single-upstream-env" },
        headers: { Authorization: "single-upstream-header" }
      });
      expect(resolved.redactor.redactForAudit({ message: "single-upstream-header" })).toEqual({
        message: "[REDACTED]"
      });
    });
  });
});

describe("audit JSONL reader", () => {
  it.skipIf(process.platform === "win32")(
    "reads a normal audit file whose parent directory is not writable",
    async () => {
      await inSandbox(async (directory) => {
        const auditPath = join(directory, "audit.jsonl");
        await writeFile(auditPath, '{"message":"readable"}\n');
        await chmod(directory, 0o500);
        const output: string[] = [];

        try {
          await readAuditJsonl({
            path: auditPath,
            redactor: new SecretRedactor(),
            write: (chunk) => output.push(chunk)
          });
        } finally {
          await chmod(directory, 0o700);
        }

        expect(output.join("")).toBe('{"message":"readable"}\n');
      });
    }
  );

  it("normalizes finite records after redacting URI credentials and a non-default profile secret", async () => {
    await inSandbox(async (directory) => {
      const configPath = join(directory, "miftah.json");
      const auditPath = join(directory, "audit.jsonl");
      await writeJson(configPath, namedUpstreamConfig("audit.jsonl"));
      await writeFile(
        auditPath,
        `${JSON.stringify({
          callbackUrl: "https://user:password@example.test/callback?access_token=uri-query-secret",
          message: "non-default-profile-env",
          profileUpstreamDetail: "profile-upstream-header"
        })}\n`
      );
      const { redactor } = await resolveRuntimeConfig(configPath);
      const output: string[] = [];

      await readAuditJsonl({ path: auditPath, redactor, write: (chunk) => output.push(chunk) });

      const normalized = output.join("");
      expect(normalized).not.toContain("password");
      expect(normalized).not.toContain("uri-query-secret");
      expect(normalized).not.toContain("non-default-profile-env");
      expect(normalized).not.toContain("profile-upstream-header");
      expect(JSON.parse(normalized)).toEqual({
        callbackUrl: "https://example.test/callback?access_token=%5BREDACTED%5D",
        message: "[REDACTED]",
        profileUpstreamDetail: "[REDACTED]"
      });
    });
  });

  it("replaces every complete malformed record with a fixed valid JSON marker", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      await writeFile(auditPath, '{"message": malformed-secret}\n');
      const output: string[] = [];

      await readAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(["malformed-secret"]),
        write: (chunk) => output.push(chunk)
      });

      expect(output.join("")).toBe(`${MALFORMED_AUDIT_RECORD}\n`);
      expect(JSON.parse(output.join(""))).toEqual(JSON.parse(MALFORMED_AUDIT_RECORD));
      expect(output.join("")).not.toContain("malformed-secret");
    });
  });

  it("replaces a complete invalid UTF-8 binary record with the fixed malformed marker", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      await writeFile(
        auditPath,
        Buffer.concat([Buffer.from('{"message":"'), Buffer.from([0xc3]), Buffer.from('"}\n')])
      );
      const output: string[] = [];

      await readAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk)
      });

      expect(output.join("")).toBe(`${MALFORMED_AUDIT_RECORD}\n`);
      expect(output.join("")).not.toContain("\uFFFD");
    });
  });

  it("retains a partial line until a later append completes it on the same file", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      await writeFile(auditPath, '{"message":"partial');
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs
      });
      try {
        await delay(pollIntervalMs * 4);
        expect(output).toEqual([]);

        await appendFile(auditPath, '-complete"}\n');
        await waitFor(() => output.length === 1);

        expect(output.join("")).toBe('{"message":"partial-complete"}\n');
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("keeps byte-split multibyte UTF-8 records intact across append polls", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      await writeFile(auditPath, "");
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs
      });
      try {
        const record = Buffer.from('{"message":"🐪"}\n');
        const split = record.indexOf(Buffer.from("🐪")) + 2;
        await appendFile(auditPath, record.subarray(0, split));
        await delay(pollIntervalMs * 4);
        expect(output).toEqual([]);

        await appendFile(auditPath, record.subarray(split));
        await waitFor(() => output.length === 1);

        expect(JSON.parse(output.join(""))).toEqual({ message: "🐪" });
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("follows appended records", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      await writeFile(auditPath, '{"sequence":1}\n');
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs
      });
      try {
        await waitFor(() => output.length === 1);
        await appendFile(auditPath, '{"sequence":2}\n');
        await waitFor(() => output.length === 2);

        expect(output.join("")).toBe('{"sequence":1}\n{"sequence":2}\n');
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("avoids prefix hashing and output staging for verified idle follower polls", async () => {
    const source = await readFile(new URL("../src/cli/audit-jsonl.ts", import.meta.url), "utf8");
    const idleFastPath = source.indexOf("if (follow && isVerifiedIdlePoll(candidate, version))");
    const firstPrefixHash = source.indexOf("let prefixHash = await hashFromHandle");

    expect(source).toContain("await handle.stat({ bigint: true })");
    expect(idleFastPath).toBeGreaterThanOrEqual(0);
    expect(idleFastPath).toBeLessThan(firstPrefixHash);
    expect(source.slice(idleFastPath, firstPrefixHash)).toContain(
      'return { kind: "staged", state: candidate, spool: undefined };'
    );
  });

  it("keeps verified idle polls silent while detecting appends and same-size rewrites", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      await writeFile(auditPath, '{"sequence":1}\n');
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs
      });
      try {
        await waitFor(() => output.length === 1);
        await delay(pollIntervalMs * 4);
        expect(output).toEqual(['{"sequence":1}\n']);

        await appendFile(auditPath, '{"sequence":2}\n');
        await waitFor(() => output.length === 2);

        await writeFile(auditPath, '{"sequence":9}\n{"sequence":3}\n');
        await waitFor(() => output.length === 4);

        expect(output.join("")).toBe(
          '{"sequence":1}\n{"sequence":2}\n{"sequence":9}\n{"sequence":3}\n'
        );
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("resets its cursor after truncation", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      await writeFile(auditPath, '{"sequence":"before-truncate"}\n');
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs
      });
      try {
        await waitFor(() => output.length === 1);
        await truncate(auditPath, 0);
        await delay(pollIntervalMs * 4);
        await appendFile(auditPath, '{"sequence":"after-truncate"}\n');
        await waitFor(() => output.length === 2);

        expect(output.join("")).toBe('{"sequence":"before-truncate"}\n{"sequence":"after-truncate"}\n');
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("resets same-inode copytruncate state before reading an equal-or-larger replacement", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      const initialContents = '{"generation":"old"}\n{"message":"stale-partial';
      const replacementContents =
        '{"generation":"replacement","padding":"this record is deliberately longer than the old cursor"}\n' +
        '{"generation":"replacement-2","padding":"this second record keeps the rewrite larger too"}\n';
      expect(Buffer.byteLength(replacementContents)).toBeGreaterThanOrEqual(Buffer.byteLength(initialContents));
      await writeFile(auditPath, initialContents);
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs: 100
      });
      try {
        await waitFor(() => output.length === 1);
        truncateSync(auditPath, 0);
        writeFileSync(auditPath, replacementContents);
        await waitFor(() => output.length === 3, 2_000);

        expect(output.join("")).toBe(
          '{"generation":"old"}\n' +
            '{"generation":"replacement","padding":"this record is deliberately longer than the old cursor"}\n' +
            '{"generation":"replacement-2","padding":"this second record keeps the rewrite larger too"}\n'
        );
        expect(output.join("")).not.toContain("stale-partial");
        expect(output).not.toContain(`${MALFORMED_AUDIT_RECORD}\n`);
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("resets same-inode copytruncate state when only an earlier consumed byte changes", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      const sharedSuffix = `{"padding":"${"x".repeat(4 * 1024)}"}\n`;
      const initialRecord = '{"generation":"old","value":"before"}\n';
      const replacementRecord = '{"generation":"new","value":"after!"}\n';
      const initialContents = initialRecord + sharedSuffix;
      const replacementContents = replacementRecord + sharedSuffix;
      expect(Buffer.byteLength(sharedSuffix)).toBeGreaterThanOrEqual(4 * 1024);
      expect(Buffer.byteLength(replacementContents)).toBeGreaterThanOrEqual(Buffer.byteLength(initialContents));
      await writeFile(auditPath, initialContents);
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs: 100
      });
      try {
        await waitFor(() => output.length === 2);
        output.length = 0;
        truncateSync(auditPath, 0);
        writeFileSync(auditPath, replacementContents);
        await waitFor(() => output.length === 2, 2_000);

        expect(output.join("")).toBe(replacementContents);
        expect(output).toContain(replacementRecord);
        expect(output.filter((chunk) => chunk === replacementRecord)).toHaveLength(1);
        expect(output.join("")).not.toContain(initialRecord);
        expect(output).not.toContain(`${MALFORMED_AUDIT_RECORD}\n`);
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("discards partial data when rename/replacement rotation changes file identity", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      const rotatedPath = join(directory, "audit.jsonl.1");
      await writeFile(auditPath, '{"message":"partial-before-rotation');
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs
      });
      try {
        await delay(pollIntervalMs * 4);
        await rename(auditPath, rotatedPath);
        await writeFile(auditPath, '{"message":"replacement"}\n');
        await waitFor(() => output.length === 1);

        expect(output.join("")).toBe('{"message":"replacement"}\n');
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("drops a pending line after the path disappears before its replacement appears", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      await writeFile(auditPath, '{"message":"partial-before-disappearance');
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs
      });
      try {
        await delay(pollIntervalMs * 4);
        await rm(auditPath);
        await delay(pollIntervalMs * 4);
        await writeFile(auditPath, '{"message":"replacement-after-disappearance"}\n');
        await waitFor(() => output.length === 1);

        expect(output.join("")).toBe('{"message":"replacement-after-disappearance"}\n');
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("observes a replacement written while follow polling races the rename boundary", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      const rotatedPath = join(directory, "audit.jsonl.race");
      await writeFile(auditPath, '{"generation":"old"}\n');
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs
      });
      try {
        const rotate = (async () => {
          await delay(1);
          await rename(auditPath, rotatedPath);
          await writeFile(auditPath, '{"generation":"replacement"}\n');
        })();
        await rotate;
        await waitFor(() => output.some((chunk) => chunk.includes("replacement")));

        expect(output.join("")).not.toContain("partial");
        expect(output.every((chunk) => {
          JSON.parse(chunk);
          return true;
        })).toBe(true);
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("waits for a path that appears after following begins", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "later.jsonl");
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs
      });
      try {
        await delay(pollIntervalMs * 4);
        await writeFile(auditPath, '{"message":"available"}\n');
        await waitFor(() => output.length === 1);

        expect(output.join("")).toBe('{"message":"available"}\n');
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("emits every record from a stable finite log spanning many fixed read chunks", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      const records = Array.from(
        { length: Math.ceil((AUDIT_READ_CHUNK_BYTES * 20) / 48) },
        (_, sequence) => JSON.stringify({ sequence, padding: "x".repeat(24) })
      );
      const contents = `${records.join("\n")}\n`;
      expect(Buffer.byteLength(contents)).toBeGreaterThan(AUDIT_READ_CHUNK_BYTES * 16);
      await writeFile(auditPath, contents);
      const output: string[] = [];

      await readAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk)
      });

      expect(output.join("")).toBe(contents);
    });
  });

  it("keeps a finite multi-block same-inode rewrite race transactional", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      const records = Array.from(
        { length: Math.ceil((AUDIT_READ_CHUNK_BYTES * 128) / 96) },
        (_, sequence) => ({ sequence, padding: "x".repeat(64) })
      );
      const originalContents = `${records
        .map((record) => JSON.stringify({ ...record, generation: "original" }))
        .join("\n")}\n`;
      const replacementContents = `${records
        .map((record) => JSON.stringify({ ...record, generation: "replaced" }))
        .join("\n")}\n`;
      expect(Buffer.byteLength(replacementContents)).toBe(Buffer.byteLength(originalContents));
      await writeFile(auditPath, originalContents);
      const initialStats = await stat(auditPath);
      let keepRewriting = true;
      let rewriteCount = 0;
      let signalFirstRewrite!: () => void;
      const firstRewrite = new Promise<void>((resolve) => {
        signalFirstRewrite = resolve;
      });
      const rewriter = (async () => {
        while (keepRewriting) {
          await writeFile(auditPath, replacementContents);
          rewriteCount += 1;
          signalFirstRewrite();
          await delay(0);
        }
      })();
      await firstRewrite;
      const output: string[] = [];
      let failure: unknown;

      try {
        await readAuditJsonl({
          path: auditPath,
          redactor: new SecretRedactor(),
          write: (chunk) => output.push(chunk)
        });
      } catch (error) {
        failure = error;
      } finally {
        keepRewriting = false;
        await rewriter;
      }

      expect(rewriteCount).toBeGreaterThan(1);
      expect((await stat(auditPath)).ino).toBe(initialStats.ino);
      if (failure !== undefined) {
        expect(failure).toBeInstanceOf(Error);
        expect(output).toEqual([]);
      } else {
        expect(createHash("sha256").update(output.join("")).digest("hex")).toBe(
          createHash("sha256").update(replacementContents).digest("hex")
        );
      }
    });
  });

  it("removes finite snapshot spools after successful output and writer failures", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      const spoolRoot = join(directory, "spools");
      const contents = '{"message":"spooled"}\n';
      await writeFile(auditPath, contents);
      await mkdir(spoolRoot, { mode: 0o700 });

      async function assertPrivateSpoolIsPresent(): Promise<void> {
        const [spoolDirectory] = await readdir(spoolRoot);
        expect(spoolDirectory).toBeDefined();
        const spoolPath = join(spoolRoot, spoolDirectory!);
        expect((await stat(spoolPath)).mode & 0o777).toBe(0o700);
        expect((await stat(join(spoolPath, "snapshot.jsonl"))).mode & 0o777).toBe(0o600);
      }

      await readAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        temporaryDirectory: spoolRoot,
        write: assertPrivateSpoolIsPresent
      });
      expect(await readdir(spoolRoot)).toEqual([]);

      const writeFailure = new Error("destination failed");
      await expect(
        readAuditJsonl({
          path: auditPath,
          redactor: new SecretRedactor(),
          temporaryDirectory: spoolRoot,
          write: async () => {
            await assertPrivateSpoolIsPresent();
            throw writeFailure;
          }
        })
      ).rejects.toBe(writeFailure);
      expect(await readdir(spoolRoot)).toEqual([]);
    });
  });

  it("marks an oversized unterminated record once and resumes after its newline", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      const secret = "oversized-record-secret";
      await writeFile(auditPath, `${secret}${"x".repeat(MAX_INCOMPLETE_AUDIT_RECORD_BYTES)}`);
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor([secret]),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs
      });
      try {
        await waitFor(() => output.length === 1);
        expect(output).toEqual([`${MALFORMED_AUDIT_RECORD}\n`]);
        expect(output.join("")).not.toContain(secret);

        await appendFile(auditPath, '\n{"sequence":"after-oversized"}\n');
        await waitFor(() => output.length === 2);
        expect(output.join("")).toBe(
          `${MALFORMED_AUDIT_RECORD}\n{"sequence":"after-oversized"}\n`
        );
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("does not repeat an oversized marker across sustained fragmented writes", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      const secret = "fragmented-oversized-secret";
      await writeFile(auditPath, "");
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor([secret]),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs
      });
      const fragment = `${secret}${"x".repeat(Math.ceil(MAX_INCOMPLETE_AUDIT_RECORD_BYTES / 4))}`;
      try {
        for (let index = 0; index < 6; index += 1) {
          await appendFile(auditPath, fragment);
          await delay(pollIntervalMs * 2);
        }
        await waitFor(() => output.length === 1);

        for (let index = 0; index < 6; index += 1) {
          await appendFile(auditPath, fragment);
          await delay(pollIntervalMs * 2);
        }
        expect(output).toEqual([`${MALFORMED_AUDIT_RECORD}\n`]);
        expect(output.join("")).not.toContain(secret);

        await appendFile(auditPath, '\n{"sequence":"after-fragments"}\n');
        await waitFor(() => output.length === 2);
        expect(output.join("")).toBe(
          `${MALFORMED_AUDIT_RECORD}\n{"sequence":"after-fragments"}\n`
        );
      } finally {
        controller.abort();
        await follower;
      }
    });
  });

  it("resolves promptly after aborting while an oversized unterminated record keeps growing", async () => {
    await inSandbox(async (directory) => {
      const auditPath = join(directory, "audit.jsonl");
      await writeFile(auditPath, "");
      const output: string[] = [];
      const controller = new AbortController();
      const follower = followAuditJsonl({
        path: auditPath,
        redactor: new SecretRedactor(),
        write: (chunk) => output.push(chunk),
        signal: controller.signal,
        pollIntervalMs
      });
      const fragment = "x".repeat(Math.ceil(MAX_INCOMPLETE_AUDIT_RECORD_BYTES / 4));
      const producer = (async () => {
        for (let index = 0; index < 32 && !controller.signal.aborted; index += 1) {
          await appendFile(auditPath, fragment);
          await delay(1);
        }
      })();
      try {
        await waitFor(() => output.length === 1, 2_000);
        const startedAt = Date.now();
        controller.abort();
        await follower;
        expect(Date.now() - startedAt).toBeLessThan(250);
        expect(output).toEqual([`${MALFORMED_AUDIT_RECORD}\n`]);
      } finally {
        controller.abort();
        await Promise.all([follower, producer]);
      }
    });
  });

  it("resolves promptly after aborting a pending poll timer", async () => {
    await inSandbox(async (directory) => {
      const controller = new AbortController();
      const startedAt = Date.now();
      const follower = followAuditJsonl({
        path: join(directory, "not-yet-created.jsonl"),
        redactor: new SecretRedactor(),
        write: () => undefined,
        signal: controller.signal,
        pollIntervalMs: 1_000
      });

      await delay(pollIntervalMs * 2);
      controller.abort();
      await follower;

      expect(Date.now() - startedAt).toBeLessThan(250);
    });
  });
});

describe("logs command integration", () => {
  it("redacts configured secrets from finite log read errors", async () => {
    await inSandbox(async (directory) => {
      const secret = "non-default-log-read-secret";
      const configPath = join(directory, "miftah.json");
      await writeJson(configPath, {
        ...namedUpstreamConfig(`audit-${secret}-missing.jsonl`),
        profiles: {
          default: {},
          work: { env: { WORK_ENV: `secretref:plain://${secret}` } }
        }
      });

      let failure: unknown;
      try {
        await runLogsCommand({ configPath, follow: false, write: () => undefined });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain(secret);
      expect((failure as Error).message).toContain("[REDACTED]");
      expect((failure as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
      const cause = (failure as Error & { cause: Error & { path?: string } }).cause;
      expect(cause.message).not.toContain(secret);
      expect(cause.path).not.toContain(secret);
      expect(cause.stack).not.toContain(secret);
    });
  });

  it("cleans up idempotent signal listeners without starting an upstream", async () => {
    await inSandbox(async (directory) => {
      const configPath = join(directory, "miftah.json");
      const sentinelPath = join(directory, "upstream-started");
      await writeJson(configPath, {
        version: "1",
        name: "logs-signal-cleanup",
        defaultProfile: "default",
        upstream: {
          transport: "stdio",
          command: process.execPath,
          args: ["--eval", `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "started")`]
        },
        profiles: { default: {} },
        audit: { path: "missing-audit.jsonl" }
      });
      const initialSigintListeners = process.listenerCount("SIGINT");
      const initialSigtermListeners = process.listenerCount("SIGTERM");
      const follow = runLogsCommand({
        configPath,
        follow: true,
        write: () => undefined,
        pollIntervalMs
      });
      try {
        await waitFor(
          () =>
            process.listenerCount("SIGINT") === initialSigintListeners + 1 &&
            process.listenerCount("SIGTERM") === initialSigtermListeners + 1
        );
        process.emit("SIGINT");
        await follow;

        expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);
        expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
        await expect(access(sentinelPath)).rejects.toThrow();
      } finally {
        process.emit("SIGTERM");
        await follow;
      }
    });
  });
});
