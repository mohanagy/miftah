import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectRoutingContext } from "../src/routing/context-collector.js";

const execFile = promisify(execFileCallback);
const testDirectories: string[] = [];

async function createProject(): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), ".routing-context-"));
  testDirectories.push(directory);
  return directory;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

function fileUri(path: string): string {
  return pathToFileURL(path).toString();
}

afterEach(async () => {
  await Promise.all(testDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("routing context collector", () => {
  it("collects only the wrapper-specific profile from a strict project marker", async () => {
    const root = await createProject();
    await writeJson(join(root, ".miftahrc.json"), {
      profiles: { github: "work", other: "personal" }
    });

    const snapshot = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: ["work", "personal"],
      cwd: root,
      environment: {},
      mcpRoots: [fileUri(root)]
    });

    expect(snapshot.context.marker).toEqual({ profile: "work" });
    expect(snapshot.profileHints).toEqual([
      { profile: "work", source: "project-marker", evidence: { kind: "marker", path: join(root, ".miftahrc.json") } }
    ]);

    await writeJson(join(root, ".miftahrc.json"), {
      profiles: { github: "work" },
      token: "must-never-be-read"
    });
    const rejectedMarker = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: ["work"],
      cwd: root,
      environment: {},
      mcpRoots: [fileUri(root)]
    });

    expect(rejectedMarker.context.marker).toBeUndefined();
    expect(rejectedMarker.profileHints).toEqual([]);
    expect(JSON.stringify(rejectedMarker)).not.toContain("must-never-be-read");
  });

  it("collects launch environment metadata without disclosing raw project data in evidence", async () => {
    const root = await createProject();
    const project = "https://token@example.test/private?secret=value";

    const snapshot = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: ["work"],
      cwd: root,
      environment: { MIFTAH_PROFILE: "work", MIFTAH_PROJECT: project },
      mcpRoots: [fileUri(root)]
    });

    expect(snapshot.context.environment).toEqual({
      profile: "work",
      project: "https://example.test/private?secret=%5BREDACTED%5D"
    });
    expect(snapshot.profileHints).toContainEqual({
      profile: "work",
      source: "environment",
      evidence: { kind: "environment", variable: "MIFTAH_PROFILE" }
    });
    expect(snapshot.evidence.environment).toEqual({ profile: "work", hasProject: true });
    expect(JSON.stringify(snapshot.evidence)).not.toContain(project);
    expect(JSON.stringify(snapshot.evidence)).not.toContain("token@example.test");
  });

  it("normalizes file roots and never probes non-file root URIs", async () => {
    const root = await createProject();
    const fileRootWithSensitiveParts = `${fileUri(root)}?token=secret#fragment`;

    const snapshot = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: [],
      cwd: root,
      environment: {},
      mcpRoots: [
        { uri: fileRootWithSensitiveParts },
        { uri: "https://user:password@example.test/repository?access_token=secret#private" }
      ]
    });

    expect(snapshot.context.fileRoots).toEqual([fileUri(root)]);
    expect(snapshot.evidence.fileRoots).toEqual([fileUri(root)]);
    expect(JSON.stringify(snapshot)).not.toContain("password");
    expect(JSON.stringify(snapshot)).not.toContain("access_token=secret");
  });

  it("selects nearest package and enclosing monorepo metadata without escaping the file root", async () => {
    const root = await createProject();
    const application = join(root, "packages", "app", "src");
    await mkdir(application, { recursive: true });
    await writeJson(join(root, ".miftahrc.json"), { profiles: { github: "work" } });
    await writeJson(join(root, "package.json"), {
      name: "@example/monorepo",
      repository: "https://token@example.test/monorepo?token=secret",
      workspaces: ["packages/*"]
    });
    await writeJson(join(root, "packages", "app", "package.json"), { name: "@example/app" });

    const snapshot = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: ["work"],
      cwd: application,
      environment: {},
      mcpRoots: [fileUri(root)]
    });

    expect(snapshot.context.cwd).toBe(application);
    expect(snapshot.context.marker).toEqual({ profile: "work" });
    expect(snapshot.context.package).toEqual({ name: "@example/app" });
    expect(snapshot.context.workspace).toEqual({
      name: "@example/monorepo",
      repository: "https://example.test/monorepo?token=%5BREDACTED%5D"
    });
    expect(snapshot.evidence.workspace).toEqual({
      path: join(root, "package.json"),
      name: "@example/monorepo",
      repository: "https://example.test/monorepo?token=%5BREDACTED%5D"
    });
  });

  it("collects a redacted Git origin and safely treats missing Git metadata as absent", async () => {
    const root = await createProject();
    await execFile("git", ["init"], { cwd: root });
    await execFile("git", ["remote", "add", "origin", "https://user:password@example.test/repo?token=secret"], {
      cwd: root
    });

    const repository = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: [],
      cwd: root,
      environment: {},
      mcpRoots: [fileUri(root)]
    });
    expect(repository.context.git).toEqual({
      origin: "https://example.test/repo?token=%5BREDACTED%5D"
    });

    const noRepository = await createProject();
    const noGitMetadata = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: [],
      cwd: noRepository,
      environment: {},
      mcpRoots: [fileUri(noRepository)]
    });
    expect(noGitMetadata.context.git).toBeUndefined();

    const unavailableGit = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: [],
      cwd: noRepository,
      environment: {},
      mcpRoots: [fileUri(noRepository)],
      gitExecutable: "miftah-git-does-not-exist"
    });
    expect(unavailableGit.context.git).toBeUndefined();
    expect(unavailableGit.evidence.git).toBeUndefined();
  });

  it("reads only a local Git origin rather than a global configuration value", async () => {
    const root = await createProject();
    const gitHome = await createProject();
    await execFile("git", ["init"], { cwd: root });
    await execFile("git", ["remote", "add", "origin", "https://source.example/repository"], { cwd: root });
    await writeFile(
      join(gitHome, ".gitconfig"),
      '[url "https://global.example/rewritten"]\n\tinsteadOf = https://source.example/\n'
    );
    const originalHome = process.env.HOME;
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.HOME = gitHome;
    process.env.XDG_CONFIG_HOME = join(gitHome, "config");

    try {
      const snapshot = await collectRoutingContext({
        wrapperName: "github",
        knownProfileNames: [],
        cwd: root,
        environment: {},
        mcpRoots: [fileUri(root)]
      });

      expect(snapshot.context.git).toEqual({ origin: "https://source.example/repository" });
      expect(snapshot.evidence.git).toEqual({ origin: "https://source.example/repository" });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
  });

  it("fails safely when an explicit profile hint is not configured", async () => {
    const root = await createProject();

    await expect(
      collectRoutingContext({
        wrapperName: "github",
        knownProfileNames: ["work"],
        cwd: root,
        environment: { MIFTAH_PROFILE: "unknown" },
        mcpRoots: [fileUri(root)]
      })
    ).rejects.toMatchObject({ code: "ROUTING_PROFILE_NOT_FOUND" });
  });

  it("excludes the explicitly supplied runtime config from automatic marker discovery", async () => {
    const root = await createProject();
    const runtimeConfigPath = join(root, "miftah.json");
    await writeJson(runtimeConfigPath, { profiles: { github: "work" } });

    const snapshot = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: ["work"],
      cwd: root,
      environment: {},
      runtimeConfigPath,
      mcpRoots: [fileUri(root)]
    });

    expect(snapshot.context.marker).toBeUndefined();
    expect(snapshot.profileHints).toEqual([]);
  });

  it("excludes a symlinked runtime config from automatic marker discovery", async () => {
    const root = await createProject();
    const runtimeConfigPath = join(root, "miftah.json");
    const runtimeConfigLink = join(root, "runtime-config.json");
    await writeJson(runtimeConfigPath, { profiles: { github: "work" } });
    await symlink(runtimeConfigPath, runtimeConfigLink);

    const snapshot = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: ["work"],
      cwd: root,
      environment: {},
      runtimeConfigPath: runtimeConfigLink,
      mcpRoots: [fileUri(root)]
    });

    expect(snapshot.context.marker).toBeUndefined();
    expect(snapshot.profileHints).toEqual([]);
  });

  it("does not follow a marker symlink outside the metadata boundary", async () => {
    const root = await createProject();
    const outside = await createProject();
    const externalMarker = join(outside, "marker.json");
    await writeJson(externalMarker, { profiles: { github: "work" } });
    await symlink(externalMarker, join(root, ".miftahrc.json"));

    const snapshot = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: ["work"],
      cwd: root,
      environment: {},
      mcpRoots: [fileUri(root)]
    });

    expect(snapshot.context.marker).toBeUndefined();
    expect(snapshot.profileHints).toEqual([]);
  });

  it("ignores an irrelevant child marker while searching enclosing metadata", async () => {
    const root = await createProject();
    const child = join(root, "packages", "app");
    await mkdir(child, { recursive: true });
    await writeJson(join(root, ".miftahrc.json"), { profiles: { github: "work" } });
    await writeJson(join(child, ".miftahrc.json"), { profiles: { other: "personal" } });

    const snapshot = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: ["work", "personal"],
      cwd: child,
      environment: {},
      mcpRoots: [fileUri(root)]
    });

    expect(snapshot.context.marker).toEqual({ profile: "work" });
    expect(snapshot.profileHints).toEqual([
      { profile: "work", source: "project-marker", evidence: { kind: "marker", path: join(root, ".miftahrc.json") } }
    ]);
  });

  it("exposes no fields outside the explicit marker and package schemas", async () => {
    const root = await createProject();
    await writeJson(join(root, ".miftahrc.json"), {
      profiles: { github: "work" },
      credentials: { token: "marker-secret" }
    });
    await writeJson(join(root, "package.json"), {
      name: "@example/package",
      repository: { url: "https://example.test/repo" },
      scripts: { build: "echo package-secret" },
      customRouting: "must-not-appear"
    });

    const snapshot = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: ["work"],
      cwd: root,
      environment: {},
      mcpRoots: [fileUri(root)]
    });

    expect(snapshot.context.package).toEqual({
      name: "@example/package",
      repository: "https://example.test/repo"
    });
    expect(JSON.stringify(snapshot)).not.toContain("marker-secret");
    expect(JSON.stringify(snapshot)).not.toContain("package-secret");
    expect(JSON.stringify(snapshot)).not.toContain("must-not-appear");
  });

  it("does not follow a symlinked cwd outside the file-root boundary", async () => {
    const root = await createProject();
    const outside = await createProject();
    const outsideApplication = join(outside, "app");
    await mkdir(outsideApplication);
    await writeJson(join(outside, ".miftahrc.json"), { profiles: { github: "work" } });
    await writeJson(join(outside, "package.json"), { name: "@outside/package" });
    await symlink(outside, join(root, "linked-project"));

    const snapshot = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: ["work"],
      cwd: join(root, "linked-project", "app"),
      environment: {},
      mcpRoots: [fileUri(root)]
    });

    expect(snapshot.context.marker).toBeUndefined();
    expect(snapshot.context.package).toBeUndefined();
    expect(snapshot.profileHints).toEqual([]);
  });

  it("does not honor inherited Git path overrides outside the file-root boundary", async () => {
    const root = await createProject();
    const outside = await createProject();
    await execFile("git", ["init"], { cwd: outside });
    await execFile("git", ["remote", "add", "origin", "https://example.test/outside"], { cwd: outside });
    const originalGitDirectory = process.env.GIT_DIR;
    process.env.GIT_DIR = join(outside, ".git");

    try {
      const snapshot = await collectRoutingContext({
        wrapperName: "github",
        knownProfileNames: [],
        cwd: root,
        environment: {},
        mcpRoots: [fileUri(root)]
      });
      expect(snapshot.context.git).toBeUndefined();
    } finally {
      if (originalGitDirectory === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = originalGitDirectory;
    }
  });

  it("does not follow a Git directory indirection outside the file-root boundary", async () => {
    const root = await createProject();
    const outside = await createProject();
    await execFile("git", ["init"], { cwd: outside });
    await execFile("git", ["remote", "add", "origin", "https://example.test/outside"], { cwd: outside });
    await writeFile(join(root, ".git"), `gitdir: ${join(outside, ".git")}\n`);

    const snapshot = await collectRoutingContext({
      wrapperName: "github",
      knownProfileNames: [],
      cwd: root,
      environment: {},
      mcpRoots: [fileUri(root)]
    });

    expect(snapshot.context.git).toBeUndefined();
    expect(snapshot.evidence.git).toBeUndefined();
  });
});
