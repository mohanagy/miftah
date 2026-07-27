import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileSetupDraftStore,
  resolveSetupDraftPath
} from "../src/setup/setup-draft.js";
import { MiftahError } from "../src/utils/errors.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "miftah-setup-draft-"));
  roots.push(root);
  return root;
}

describe("setup drafts", () => {
  it("persists only a bounded connector intent, then resumes and discards it", async () => {
    const directory = await createRoot();
    const store = new FileSetupDraftStore({
      directory,
      now: () => "2026-07-25T12:00:00.000Z"
    });

    const saved = await store.save({
      source: "connector",
      name: "posthog-work",
      preset: "generic",
      stage: "connection"
    });

    expect(saved).toEqual({
      schemaVersion: 1,
      revision: 1,
      source: "connector",
      name: "posthog-work",
      preset: "generic",
      stage: "connection",
      savedAt: "2026-07-25T12:00:00.000Z"
    });
    await expect(store.load()).resolves.toEqual(saved);
    await expect(readFile(resolveSetupDraftPath(directory), "utf8")).resolves.toContain('"preset":"generic"');
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(resolveSetupDraftPath(directory))).mode & 0o777).toBe(0o600);
      if (typeof process.getuid === "function") {
        expect((await stat(resolveSetupDraftPath(directory))).uid).toBe(process.getuid());
      }
    }

    await store.discard(saved.revision);
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("rejects stale draft updates instead of overwriting another setup surface", async () => {
    const directory = await createRoot();
    const first = new FileSetupDraftStore({ directory });
    const second = new FileSetupDraftStore({ directory });
    const saved = await first.save({
      source: "connector",
      name: "support-tools",
      preset: "generic",
      stage: "connection"
    });

    await expect(second.save({
      source: "connector",
      name: "support-tools",
      preset: "sentry",
      stage: "connection"
    }, saved.revision - 1)).rejects.toMatchObject({ code: "SETUP_DRAFT_CONFLICT" });
    await expect(first.load()).resolves.toEqual(saved);
  });

  it("fails closed when a draft contains an excluded connection or credential field", async () => {
    const directory = await createRoot();
    await writeFile(resolveSetupDraftPath(directory), JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      source: "connector",
      name: "posthog-work",
      preset: "generic",
      stage: "connection",
      savedAt: "2026-07-25T12:00:00.000Z",
      credentialEnv: "POSTHOG_PERSONAL_API_KEY"
    }), { mode: 0o600 });
    await chmod(directory, 0o700);

    await expect(new FileSetupDraftStore({ directory }).load()).rejects.toMatchObject({
      code: "SETUP_DRAFT_INVALID"
    } satisfies Partial<MiftahError>);
  });

  it("rejects an oversized persisted draft as invalid without accepting arbitrary content", async () => {
    const directory = await createRoot();
    await writeFile(resolveSetupDraftPath(directory), "x".repeat(4 * 1024 + 1), { mode: 0o600 });
    await chmod(directory, 0o700);

    await expect(new FileSetupDraftStore({ directory }).load()).rejects.toMatchObject({
      code: "SETUP_DRAFT_INVALID"
    } satisfies Partial<MiftahError>);
  });

  it("refuses a draft symlink before treating its target as persisted setup state", async () => {
    const directory = await createRoot();
    const target = join(directory, "untrusted-target.json");
    await writeFile(target, "x".repeat(5 * 1024), { mode: 0o600 });
    await chmod(directory, 0o700);
    await symlink(target, resolveSetupDraftPath(directory));

    await expect(new FileSetupDraftStore({ directory }).load()).rejects.toMatchObject({
      code: "SETUP_DRAFT_UNAVAILABLE"
    } satisfies Partial<MiftahError>);
  });

  it("refuses a symlinked draft directory instead of resuming from another location", async () => {
    const root = await createRoot();
    const directory = join(root, "setup");
    const target = join(root, "other-setup");
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, "setup-draft-v1.json"), JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      source: "connector",
      name: "posthog-work",
      preset: "generic",
      stage: "connection",
      savedAt: "2026-07-25T12:00:00.000Z"
    }), { mode: 0o600 });
    await symlink(target, directory);

    await expect(new FileSetupDraftStore({ directory }).load()).rejects.toMatchObject({
      code: "SETUP_DRAFT_UNAVAILABLE"
    } satisfies Partial<MiftahError>);
  });

  it("refuses unbounded configuration labels and unknown catalog presets before writing a draft", async () => {
    const directory = await createRoot();
    const store = new FileSetupDraftStore({ directory });

    await expect(store.save({
      source: "connector",
      name: "this label has whitespace",
      preset: "generic",
      stage: "connection"
    })).rejects.toMatchObject({ code: "SETUP_DRAFT_INPUT_INVALID" });
    await expect(store.save({
      source: "connector",
      name: "posthog-work",
      preset: "unknown-connector",
      stage: "connection"
    })).rejects.toMatchObject({ code: "SETUP_DRAFT_INPUT_INVALID" });
    await expect(store.load()).resolves.toBeUndefined();
  });
});
