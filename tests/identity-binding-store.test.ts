import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileIdentityBindingStore } from "../src/identity/identity-binding-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("identity binding store", () => {
  it("atomically persists only bounded identity records with restrictive permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-identity-bindings-"));
    directories.push(directory);
    const path = join(directory, "nested", "bindings.json");
    const store = new FileIdentityBindingStore(path);
    const record = {
      version: 1 as const,
      profile: "work",
      upstream: null,
      configurationFingerprint: "a".repeat(64),
      evidence: { provider: "github", login: "mona", organization: "lubab" },
      verifiedAt: "2026-07-22T10:00:00.000Z"
    };

    await store.save([record]);

    await expect(store.load()).resolves.toEqual([record]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, records: [record] });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects corrupt records with a stable diagnostic and no stored content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-identity-bindings-invalid-"));
    directories.push(directory);
    const path = join(directory, "bindings.json");
    await writeFile(path, JSON.stringify({ version: 1, records: [{ rawToken: "must-not-leak" }] }));

    await expect(new FileIdentityBindingStore(path).load()).rejects.toMatchObject({
      code: "IDENTITY_BINDING_UNAVAILABLE",
      message: expect.not.stringContaining("must-not-leak")
    });
  });

  it("does not lose bindings when independent stores save different profiles concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-identity-bindings-concurrent-"));
    directories.push(directory);
    const path = join(directory, "bindings.json");
    const work = {
      version: 1 as const,
      profile: "work",
      upstream: null,
      configurationFingerprint: "a".repeat(64),
      evidence: { login: "work" },
      verifiedAt: "2026-07-22T10:00:00.000Z"
    };
    const personal = {
      version: 1 as const,
      profile: "personal",
      upstream: null,
      configurationFingerprint: "b".repeat(64),
      evidence: { login: "personal" },
      verifiedAt: "2026-07-22T10:00:01.000Z"
    };

    await Promise.all([
      new FileIdentityBindingStore(path).save([work]),
      new FileIdentityBindingStore(path).save([personal])
    ]);

    await expect(new FileIdentityBindingStore(path).load()).resolves.toEqual(
      expect.arrayContaining([work, personal])
    );
  });
});
