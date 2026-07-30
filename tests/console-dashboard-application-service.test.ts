import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverConsoleConfigCatalog,
  sameBigIntFileIdentity,
  type ConsoleConfigCatalogCandidateIdentityDiagnosticEvent,
  type ConsoleConfigCatalogCandidateStageEvent,
  type ConsoleConfigCatalogDiscoveryOptions
} from "../src/console/console-config-catalog.js";
import { ConsoleDashboardApplicationService } from "../src/console/console-dashboard-application-service.js";
import { buildPresetConfig } from "../src/config/presets.js";
import { verifyWindowsConfigPathSecurity } from "../src/cli/windows-config-acl.js";
import { FileSetupDraftStore } from "../src/setup/setup-draft.js";
import { MiftahError } from "../src/utils/errors.js";
import {
  createPrivateConsoleDirectory,
  writePrivateConsoleFile
} from "./helpers/private-console-directory.js";
import { environmentProfileConfig } from "./helpers/environment-profile-config.js";
import { startOAuthCompatibilityProbe } from "./helpers/fake-remote-upstream.js";

const temporaryDirectories: string[] = [];
const catalogAclDiagnostic = vi.hoisted(() => ({
  verifier: undefined as undefined | ((path: string, kind: "file" | "directory") => Promise<boolean>)
}));
const catalogStageDiagnostic = vi.hoisted(() => ({
  observer: undefined as undefined | ((event: ConsoleConfigCatalogCandidateStageEvent) => void)
}));
const catalogIdentityDiagnostic = vi.hoisted(() => ({
  observer: undefined as undefined | ((event: ConsoleConfigCatalogCandidateIdentityDiagnosticEvent) => void)
}));
const catalogDiscoveryDiagnostic = vi.hoisted(() => ({
  invocations: 0,
  afterDiscover: undefined as undefined | ((invocation: number) => Promise<void>)
}));

vi.mock("../src/console/console-config-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/console/console-config-catalog.js")>();
  return {
    ...actual,
    async discoverConsoleConfigCatalog(options: Parameters<typeof actual.discoverConsoleConfigCatalog>[0]) {
      const verifier = catalogAclDiagnostic.verifier;
      const observer = catalogStageDiagnostic.observer;
      const identityObserver = catalogIdentityDiagnostic.observer;
      const instrumentedOptions = {
        ...options,
        ...(verifier === undefined ? {} : { windowsAclVerifier: verifier }),
        ...(observer === undefined ? {} : { candidateStageObserver: observer }),
        ...(identityObserver === undefined ? {} : { candidateIdentityObserver: identityObserver })
      };
      catalogDiscoveryDiagnostic.invocations += 1;
      const result = await actual.discoverConsoleConfigCatalog(instrumentedOptions);
      await catalogDiscoveryDiagnostic.afterDiscover?.(catalogDiscoveryDiagnostic.invocations);
      return result;
    }
  };
});

function supportedKnownConnectorOptions(): {
  readonly preset: string;
  readonly npmPackage?: string;
  readonly dockerImage?: string;
} {
  return process.platform === "win32"
    ? {
        preset: "generic-docker",
        dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      }
    : {
        preset: "generic-npx",
        npmPackage: "@scope/server@1.2.3"
      };
}

function importableClientEntry(): { readonly command: string; readonly args: readonly string[] } {
  return process.platform === "win32"
    ? { command: process.execPath, args: ["server.mjs"] }
    : { command: "npx", args: ["--yes", "@posthog/mcp@1.2.3"] };
}

afterEach(async () => {
  catalogAclDiagnostic.verifier = undefined;
  catalogStageDiagnostic.observer = undefined;
  catalogIdentityDiagnostic.observer = undefined;
  catalogDiscoveryDiagnostic.invocations = 0;
  catalogDiscoveryDiagnostic.afterDiscover = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function writeConfig(path: string, value: unknown): Promise<void> {
  await writePrivateConsoleFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeCatalogFixture(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function catalogFixtureLabel(path: string, kind: "file" | "directory"): "directory" | "gsc" | "sentry" | "other" {
  if (kind === "directory") return "directory";
  switch (basename(path).toLocaleLowerCase("en-US")) {
    case "gsc.json":
      return "gsc";
    case "sentry.json":
      return "sentry";
    default:
      return "other";
  }
}

async function compareFileIdentities(first: string, second: string): Promise<{
  readonly bigintIdentity: "same" | "different";
  readonly numberIdentity: "same" | "different";
}> {
  const [firstNumber, secondNumber, firstBigInt, secondBigInt] = await Promise.all([
    lstat(first),
    lstat(second),
    lstat(first, { bigint: true }),
    lstat(second, { bigint: true })
  ]);
  return {
    numberIdentity: firstNumber.dev === secondNumber.dev && firstNumber.ino === secondNumber.ino ? "same" : "different",
    bigintIdentity: firstBigInt.dev === secondBigInt.dev && firstBigInt.ino === secondBigInt.ino ? "same" : "different"
  };
}

async function compareOpenedFileIdentities(first: string, second: string): Promise<{
  readonly bigintIdentity: "same" | "different";
  readonly numberIdentity: "same" | "different";
}> {
  const [firstHandle, secondHandle] = await Promise.all([open(first, "r"), open(second, "r")]);
  try {
    const [firstNumber, secondNumber, firstBigInt, secondBigInt] = await Promise.all([
      firstHandle.stat(),
      secondHandle.stat(),
      firstHandle.stat({ bigint: true }),
      secondHandle.stat({ bigint: true })
    ]);
    return {
      numberIdentity: firstNumber.dev === secondNumber.dev && firstNumber.ino === secondNumber.ino ? "same" : "different",
      bigintIdentity: firstBigInt.dev === secondBigInt.dev && firstBigInt.ino === secondBigInt.ino ? "same" : "different"
    };
  } finally {
    await Promise.all([firstHandle.close(), secondHandle.close()]);
  }
}

function catalogStageSummary(
  events: readonly ConsoleConfigCatalogCandidateStageEvent[],
  configurationNames: readonly string[] | undefined
): readonly {
  readonly candidate: "gsc" | "sentry";
  readonly stages: readonly Omit<ConsoleConfigCatalogCandidateStageEvent, "candidateIndex">[];
  readonly accepted: boolean;
}[] {
  // The catalog sorts the only two JSON fixtures alphabetically: gsc is index 0, sentry is index 1.
  const candidates = ["gsc", "sentry"] as const;
  return candidates.map((candidate, candidateIndex) => ({
    candidate,
    stages: events
      .filter((event) => event.candidateIndex === candidateIndex)
      .map(({ stage, outcome }) => ({ stage, outcome })),
    accepted: configurationNames?.includes(candidate) ?? false
  }));
}

describe("Console dashboard application service", () => {
  it("keeps distinct lossless file identities separate when Number coercion collides", () => {
    const first = { dev: 1n, ino: 9_007_199_254_740_992n };
    const second = { dev: 1n, ino: 9_007_199_254_740_993n };

    expect(Number(first.ino)).toBe(Number(second.ino));
    expect(sameBigIntFileIdentity(first, second)).toBe(false);
  });

  it.runIf(process.platform === "win32")("creates fixture files that pass the production Windows ACL verifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-acl-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    const configPath = join(directory, "fixture.json");
    await writeConfig(configPath, {
      version: "3",
      name: "fixture",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { default: {} }
    });

    await expect(verifyWindowsConfigPathSecurity(configPath, "file")).resolves.toBe(true);
  });

  it("discovers safe standard-directory configurations without exposing source details", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);

    const gscPath = join(directory, "gsc.json");
    await writeConfig(gscPath, {
      version: "3",
      name: "gsc",
      defaultProfile: "google-work",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: {
        "google-work": {
          env: { GSC_OAUTH_CLIENT_SECRETS_FILE: "/private/client-secrets.json" }
        }
      }
    });
    const sentryPath = join(directory, "sentry.json");
    await writeConfig(sentryPath, {
      version: "3",
      name: "sentry",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "npx", args: ["--yes", "@sentry/mcp-server@0.36.0"] },
      profiles: { work: {} }
    });

    const fixtureIdentity = process.platform === "win32"
      ? await compareFileIdentities(gscPath, sentryPath)
      : undefined;
    const openedFixtureIdentity = process.platform === "win32"
      ? await compareOpenedFileIdentities(gscPath, sentryPath)
      : undefined;
    const candidateStages: ConsoleConfigCatalogCandidateStageEvent[] = [];
    catalogStageDiagnostic.observer = (event) => {
      candidateStages.push(event);
    };
    const candidateIdentities: ConsoleConfigCatalogCandidateIdentityDiagnosticEvent[] = [];
    if (process.platform === "win32") {
      catalogIdentityDiagnostic.observer = (event) => {
        candidateIdentities.push(event);
      };
    }

    // Instrument the exact dashboard catalog invocation on Windows. The mock
    // delegates to the real catalog and real verifier; it only records safe
    // fixture labels so a fail-closed omission identifies its boundary.
    const aclProbes: Array<{
      candidate: "directory" | "gsc" | "sentry" | "other";
      kind: "file" | "directory";
      outcome: "trusted" | "untrusted" | "error";
    }> = [];
    if (process.platform === "win32") {
      catalogAclDiagnostic.verifier = async (path, kind) => {
        const candidate = catalogFixtureLabel(path, kind);
        try {
          const trusted = await verifyWindowsConfigPathSecurity(path, kind);
          aclProbes.push({ candidate, kind, outcome: trusted ? "trusted" : "untrusted" });
          return trusted;
        } catch (error) {
          aclProbes.push({ candidate, kind, outcome: "error" });
          throw error;
        }
      };
    }

    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] }
    });

    const initial = await service.configMetadata().finally(() => {
      catalogAclDiagnostic.verifier = undefined;
      catalogStageDiagnostic.observer = undefined;
    });
    expect({
      stageSummary: catalogStageSummary(candidateStages, initial.catalog?.configurations.map((configuration) => configuration.name))
    }).toEqual({
      stageSummary: [
        {
          candidate: "gsc",
          stages: [
            { stage: "acl", outcome: "success" },
            { stage: "open", outcome: "success" },
            { stage: "opened-validation", outcome: "success" },
            { stage: "read", outcome: "success" },
            { stage: "after-read-validation", outcome: "success" },
            { stage: "decode", outcome: "success" },
            { stage: "parse", outcome: "success" },
            { stage: "migration-source", outcome: "success" },
            { stage: "close", outcome: "success" },
            { stage: "dedupe", outcome: "success" },
            { stage: "metadata", outcome: "success" },
            { stage: "accepted", outcome: "success" }
          ],
          accepted: true
        },
        {
          candidate: "sentry",
          stages: [
            { stage: "acl", outcome: "success" },
            { stage: "open", outcome: "success" },
            { stage: "opened-validation", outcome: "success" },
            { stage: "read", outcome: "success" },
            { stage: "after-read-validation", outcome: "success" },
            { stage: "decode", outcome: "success" },
            { stage: "parse", outcome: "success" },
            { stage: "migration-source", outcome: "success" },
            { stage: "close", outcome: "success" },
            { stage: "dedupe", outcome: "success" },
            { stage: "metadata", outcome: "success" },
            { stage: "accepted", outcome: "success" }
          ],
          accepted: true
        }
      ]
    });
    if (process.platform === "win32") {
      // Number identities are diagnostic only: Windows may legitimately collapse
      // these distinct files. The catalog must retain both through BigInt IDs.
      expect(fixtureIdentity?.bigintIdentity).toBe("different");
      expect(openedFixtureIdentity?.bigintIdentity).toBe("different");
      expect(candidateIdentities).toHaveLength(2);
      expect(candidateIdentities[0]).toEqual({ candidateIndex: 0, bigintDuplicate: false, numberDuplicate: false });
      expect(candidateIdentities[1]?.candidateIndex).toBe(1);
      expect(candidateIdentities[1]?.bigintDuplicate).toBe(false);
      expect(typeof candidateIdentities[1]?.numberDuplicate).toBe("boolean");
      expect({
        aclProbeSummary: [...aclProbes].sort((left, right) => left.candidate.localeCompare(right.candidate)),
        serviceConfigurationNames: initial.catalog?.configurations.map((configuration) => configuration.name)
      }).toEqual({
        aclProbeSummary: [
          { candidate: "directory", kind: "directory", outcome: "trusted" },
          { candidate: "gsc", kind: "file", outcome: "trusted" },
          { candidate: "sentry", kind: "file", outcome: "trusted" }
        ],
        serviceConfigurationNames: ["gsc", "sentry"]
      });
    }
    expect(initial).toMatchObject({
      initialized: false,
      restartRequiredForExistingClients: true,
      catalog: {
        source: "standard-config-directory",
        configurations: [
          {
            name: "gsc",
            defaultProfile: "google-work",
            profileCount: 1,
            authentication: {
              mode: "provider-adapter",
              provider: "Google Search Console",
              credentialOwner: "upstream"
            }
          },
          {
            name: "sentry",
            defaultProfile: "work",
            profileCount: 1
          }
        ]
      }
    });
    expect(initial.initialized).toBe(false);
    expect(initial.catalog?.configurations).toHaveLength(2);
    expect(JSON.stringify(initial)).not.toContain(directory);
    expect(JSON.stringify(initial)).not.toContain("client-secrets.json");
  });

  it("rejects an unsafe returning-user configuration name before native OAuth onboarding", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-onboard-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    await writeConfig(join(directory, "gsc.json"), {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] }
    });

    for (const name of ["../must-not-escape", "alpha\n", "alpha\u2028", "alpha\u2029"]) {
      await expect(service.onboardNativeOAuth({
        name,
        profile: "default",
        resource: "https://mcp.example.test/mcp",
        issuer: "https://auth.example.test",
        clientRegistration: "dynamic",
        scopes: []
      })).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_TARGET_INVALID" });
    }
    await expect(readFile(join(root, "must-not-escape.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("fails closed when the created configuration cannot be canonicalized", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-created-realpath-"));
    temporaryDirectories.push(root);
    const directory = await realpath(await createPrivateConsoleDirectory(root));
    await writeConfig(join(directory, "gsc.json"), {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });
    const target = join(directory, "support-tools.json");
    let replacementHookRan = false;
    catalogDiscoveryDiagnostic.afterDiscover = async (invocation) => {
      if (invocation !== 2) return;
      replacementHookRan = true;
      await rm(target);
      await symlink("support-tools.json", target);
    };
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });
    const { preset, ...presetOptions } = supportedKnownConnectorOptions();

    await expect(service.onboardPreset({
      name: "support-tools",
      preset,
      ...presetOptions
    })).rejects.toMatchObject({ code: "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE" });
    expect(replacementHookRan).toBe(true);
  });

  it.skipIf(process.platform === "win32")("does not publish through a configuration directory replaced after discovery", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "miftah-console-dashboard-directory-swap-")));
    temporaryDirectories.push(root);
    const directory = await realpath(await createPrivateConsoleDirectory(root));
    const replacement = await realpath(await createPrivateConsoleDirectory(root, "replacement"));
    const movedDirectory = join(root, "original-configs");
    await writeConfig(join(directory, "gsc.json"), {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });
    let replacementHookRan = false;
    catalogDiscoveryDiagnostic.afterDiscover = async (invocation) => {
      if (invocation !== 1) return;
      replacementHookRan = true;
      await rename(directory, movedDirectory);
      await symlink(replacement, directory);
    };
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });
    const { preset, ...presetOptions } = supportedKnownConnectorOptions();

    await expect(service.onboardPreset({
      name: "support-tools",
      preset,
      ...presetOptions
    })).rejects.toMatchObject({ code: "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE" });
    await expect(readFile(join(replacement, "support-tools.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(replacement, ".miftah", "audit", "console.jsonl"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(replacementHookRan).toBe(true);
  });

  it("forces fresh catalog discovery when confirming a published configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-fresh-confirmation-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root, "private-parent");
    const directory = await createPrivateConsoleDirectory(privateParent);
    await writeConfig(join(directory, "gsc.json"), {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });
    let releaseStaleDiscovery: (() => void) | undefined;
    const staleDiscoveryHeld = new Promise<void>((resolve) => {
      releaseStaleDiscovery = resolve;
    });
    let reportStaleDiscovery: (() => void) | undefined;
    const staleDiscoveryReported = new Promise<void>((resolve) => {
      reportStaleDiscovery = resolve;
    });
    catalogDiscoveryDiagnostic.afterDiscover = async (invocation) => {
      if (invocation !== 1) return;
      reportStaleDiscovery?.();
      await staleDiscoveryHeld;
    };
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });
    const staleMetadata = service.configMetadata();
    await staleDiscoveryReported;
    const createdPath = join(directory, "support-tools.json");
    await writeConfig(createdPath, {
      version: "3",
      name: "support-tools",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node", args: ["server.mjs"] },
      profiles: { default: {} }
    });

    const confirmation = (
      service as unknown as {
        confirmCreatedFirstRunConfiguration(path: string): Promise<void>;
      }
    ).confirmCreatedFirstRunConfiguration(createdPath);
    releaseStaleDiscovery?.();

    await expect(staleMetadata).resolves.toBeDefined();
    await expect(confirmation).resolves.toBeUndefined();
    expect(catalogDiscoveryDiagnostic.invocations).toBe(2);
  });

  it.skipIf(process.platform === "win32")("rejects a returning setup audit directory readable by the group", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-audit-directory-mode-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root, "private-parent");
    const directory = await createPrivateConsoleDirectory(privateParent);
    await writeConfig(join(directory, "gsc.json"), {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });
    const auditDirectory = join(directory, ".miftah");
    await mkdir(auditDirectory, { mode: 0o740 });
    await chmod(auditDirectory, 0o740);
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });
    const { preset, ...presetOptions } = supportedKnownConnectorOptions();

    await expect(service.onboardPreset({
      name: "support-tools",
      preset,
      ...presetOptions
    })).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    await expect(readFile(join(directory, "support-tools.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates another named configuration from the returning-user dashboard", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-returning-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root, "private-parent");
    const directory = await createPrivateConsoleDirectory(privateParent);
    const existingPath = join(directory, "gsc.json");
    const existing = {
      version: "3" as const,
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio" as const, command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    };
    await writeConfig(existingPath, existing);
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] }
    });
    const { preset, ...presetOptions } = supportedKnownConnectorOptions();

    await expect(service.previewPreset({
      name: "support-tools.json",
      preset,
      ...presetOptions
    })).resolves.toMatchObject({
      write: false,
      name: "support-tools",
      configuration: { publication: "new-file-only" }
    });
    await expect(readFile(join(directory, "support-tools.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    await expect(service.onboardPreset({
      name: "support-tools.json",
      preset,
      ...presetOptions
    })).resolves.toMatchObject({ name: "support-tools", defaultProfile: "default" });
    expect(JSON.parse(await readFile(join(directory, "support-tools.json"), "utf8"))).toEqual(
      buildPresetConfig("support-tools", preset, presetOptions)
    );
    const auditRecords = (await readFile(join(directory, ".miftah", "audit", "console.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({
      wrapper: "miftah-console",
      kind: "lifecycle",
      operation: "console/onboard-preset",
      name: "configuration",
      profile: "default",
      status: "success",
      schemaVersion: 1
    });
    expect(JSON.parse(await readFile(existingPath, "utf8"))).toEqual(existing);
    await expect(readFile(join(directory, "miftah.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites a returning-user target or duplicates a discovered configuration name", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-returning-collision-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root, "private-parent");
    const directory = await createPrivateConsoleDirectory(privateParent);
    await writeConfig(join(directory, "gsc.json"), {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });
    const occupiedPath = join(directory, "support-tools.json");
    const occupied = `${JSON.stringify({
      version: "3",
      name: "occupied",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node", args: ["server.mjs"] },
      profiles: { default: {} }
    })}\n`;
    await writePrivateConsoleFile(occupiedPath, occupied);
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });
    const { preset, ...presetOptions } = supportedKnownConnectorOptions();

    await expect(service.onboardPreset({
      name: "gsc",
      preset,
      ...presetOptions
    })).rejects.toMatchObject({ code: "CONFIG_ALREADY_EXISTS" });
    await expect(service.onboardPreset({
      name: "support-tools",
      preset,
      ...presetOptions
    })).rejects.toMatchObject({ code: "CONFIG_ALREADY_EXISTS" });
    await expect(readFile(occupiedPath, "utf8")).resolves.toBe(occupied);
  });

  it("uses a distinct safe returning-user target for native OAuth setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-returning-oauth-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root, "private-parent");
    const directory = await createPrivateConsoleDirectory(privateParent);
    await writeConfig(join(directory, "gsc.json"), {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] }
    });

    await expect(service.onboardNativeOAuth({
      name: "analytics-oauth",
      profile: "work",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: []
    })).resolves.toMatchObject({ profile: "work", write: true });
    await expect(readFile(join(directory, "analytics-oauth.json"), "utf8"))
      .resolves.toContain('"name": "analytics-oauth"');
    await expect(readFile(join(directory, "miftah.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts credential-shaped returning-user setup audit fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-returning-audit-redaction-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root, "private-parent");
    const directory = await createPrivateConsoleDirectory(privateParent);
    await writeConfig(join(directory, "gsc.json"), {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] }
    });
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz";
    const profile = `https://user:password@example.test/${secret}`;

    await expect(service.onboardNativeOAuth({
      name: "analytics-oauth",
      profile,
      resource: "https://mcp.example.test/mcp",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: []
    })).resolves.toMatchObject({ profile, write: true });

    const audit = await readFile(join(directory, ".miftah", "audit", "console.jsonl"), "utf8");
    expect(audit).not.toContain("user:password");
    expect(audit).not.toContain(secret);
    expect(audit).toContain("[REDACTED]");
  });

  it("uses a distinct safe returning-user target for selected client entry setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-returning-client-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root, "private-parent");
    const directory = await createPrivateConsoleDirectory(privateParent);
    await writeConfig(join(directory, "gsc.json"), {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] }
    });

    await expect(service.onboardClientEntry({
      name: "posthog-work",
      entry: "posthog",
      document: JSON.stringify({ mcpServers: { posthog: importableClientEntry() } })
    })).resolves.toMatchObject({ name: "posthog-work", write: true });
    await expect(readFile(join(directory, "posthog-work.json"), "utf8"))
      .resolves.toContain('"name": "posthog-work"');
    await expect(readFile(join(directory, "miftah.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a first known connector through the same dashboard setup boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-preset-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const directory = join(privateParent, "miftah");
    const configPath = join(directory, "miftah.json");
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: configPath,
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] }
    });

    const { preset, ...presetOptions } = supportedKnownConnectorOptions();
    await expect(service.onboardPreset({
      name: "support-tools",
      preset,
      ...presetOptions
    })).resolves.toMatchObject({ name: "support-tools", defaultProfile: "default" });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(
      buildPresetConfig("support-tools", preset, presetOptions)
    );
    await expect(service.health()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
  });

  it("shares only a safe connector draft during first run", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-draft-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const directory = join(privateParent, "miftah");
    const configPath = join(directory, "miftah.json");
    const draftStore = new FileSetupDraftStore({ directory: join(privateParent, "setup-draft") });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: configPath,
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] },
      setupDraftStore: draftStore
    });
    const { preset } = supportedKnownConnectorOptions();
    const saveSetupDraft = service.saveSetupDraft;
    const loadSetupDraft = service.loadSetupDraft;
    if (saveSetupDraft === undefined || loadSetupDraft === undefined) {
      throw new Error("Expected the first-run service to expose the configured setup-draft capability.");
    }

    const draft = await saveSetupDraft({
      source: "connector",
      name: "support-tools",
      preset,
      stage: "connection"
    });
    await expect(loadSetupDraft()).resolves.toEqual(draft);
  });

  it("clears a real first-run connector draft after configuration publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-draft-publication-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const directory = join(privateParent, "miftah");
    const configPath = join(directory, "miftah.json");
    const draftStore = new FileSetupDraftStore({ directory: join(privateParent, "setup-draft") });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: configPath,
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] },
      setupDraftStore: draftStore
    });
    const { preset, ...presetOptions } = supportedKnownConnectorOptions();
    const saveSetupDraft = service.saveSetupDraft;
    const loadSetupDraft = service.loadSetupDraft;
    if (saveSetupDraft === undefined || loadSetupDraft === undefined) {
      throw new Error("Expected the first-run service to expose the configured setup-draft capability.");
    }

    await saveSetupDraft({
      source: "connector",
      name: "support-tools",
      preset,
      stage: "connection"
    });

    await expect(service.onboardPreset({
      name: "support-tools",
      preset,
      ...presetOptions
    })).resolves.toMatchObject({ name: "support-tools" });
    await expect(draftStore.load()).resolves.toBeUndefined();
    await expect(loadSetupDraft()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
  });

  it.runIf(process.platform === "win32")("cleans up a real first-run connector draft without configuration publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-draft-cleanup-boundary-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const draftStore = new FileSetupDraftStore({ directory: join(privateParent, "setup-draft") });

    const saved = await draftStore.save({
      source: "connector",
      name: "support-tools",
      preset: "generic",
      stage: "connection"
    });
    await expect(draftStore.load()).resolves.toEqual(saved);
    await expect(draftStore.discard(saved.revision)).resolves.toBeUndefined();
    await expect(draftStore.load()).resolves.toBeUndefined();
  });

  it("keeps a published first-run configuration when cached draft cleanup conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-draft-cleanup-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const directory = join(privateParent, "miftah");
    const configPath = join(directory, "miftah.json");
    const draft = {
      schemaVersion: 1 as const,
      revision: 1,
      source: "connector" as const,
      name: "support-tools",
      preset: "generic",
      stage: "connection" as const,
      savedAt: "2026-07-25T12:00:00.000Z"
    };
    const draftStore = {
      load: vi.fn(async () => draft),
      save: vi.fn(async () => draft),
      discard: vi.fn(async () => {
        throw new MiftahError(
          "SETUP_DRAFT_CONFLICT",
          "SETUP_DRAFT_CONFLICT: setup draft changed in another CLI or Console session"
        );
      })
    };
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: configPath,
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] },
      setupDraftStore: draftStore
    });
    const { preset, ...presetOptions } = supportedKnownConnectorOptions();
    const saveSetupDraft = service.saveSetupDraft;
    if (saveSetupDraft === undefined) {
      throw new Error("Expected the first-run service to expose the configured setup-draft capability.");
    }

    try {
      await expect(saveSetupDraft({
        source: "connector",
        name: "support-tools",
        preset: "generic",
        stage: "connection"
      })).resolves.toEqual(draft);
      await expect(service.onboardPreset({
        name: "support-tools",
        preset,
        ...presetOptions
      })).resolves.toMatchObject({ name: "support-tools" });
      await expect(readFile(configPath, "utf8")).resolves.toContain('"name": "support-tools"');
      expect(draftStore.load).not.toHaveBeenCalled();
      expect(draftStore.discard).toHaveBeenCalledWith(1);
      expect(warning).toHaveBeenCalledWith(
        "Configuration was created, but Miftah could not clear the saved connector choice (SETUP_DRAFT_CONFLICT). Run 'miftah setup --discard-draft' to remove it later.",
        { code: "MIFTAH_SETUP_DRAFT_CLEANUP_FAILED" }
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("does not expose connector-draft operations when its embedding has no draft store", () => {
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(tmpdir(), "miftah-console-dashboard-no-draft-store.json"),
      configDirectory: tmpdir(),
      launcher: { command: process.execPath, args: ["serve"] }
    });

    expect(service.loadSetupDraft).toBeUndefined();
    expect(service.saveSetupDraft).toBeUndefined();
    expect(service.discardSetupDraft).toBeUndefined();
  });

  it("previews a first known connector without selecting or creating a configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-preset-preview-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const directory = join(privateParent, "miftah");
    const configPath = join(directory, "miftah.json");
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: configPath,
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] }
    });
    const { preset, ...presetOptions } = supportedKnownConnectorOptions();

    await expect(service.previewPreset({
      name: "support-tools",
      preset,
      ...presetOptions
    })).resolves.toMatchObject({
      changed: false,
      write: false,
      name: "support-tools",
      defaultProfile: "default",
      configuration: { sensitiveValues: "omitted" }
    });
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.health()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
  });

  it("creates one selected local stdio entry only through the first-run dashboard boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-client-entry-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const directory = join(privateParent, "miftah");
    const configPath = join(directory, "miftah.json");
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: configPath,
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] }
    });
    const entry = importableClientEntry();

    await expect(service.onboardClientEntry({
      name: "posthog-work",
      entry: "posthog",
      document: JSON.stringify({
        mcpServers: { posthog: entry }
      })
    })).resolves.toMatchObject({ name: "posthog-work", defaultProfile: "default" });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      name: "posthog-work",
      profiles: { default: { policy: "readonly" } }
    });
    await expect(service.health()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
  });

  it("selects an explicitly discovered configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-selection-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    await writeConfig(join(directory, "gsc.json"), {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });
    const initial = await service.configMetadata();
    const gsc = initial.catalog?.configurations.find((configuration) => configuration.name === "gsc");
    if (gsc === undefined) throw new Error("Expected discovered GSC configuration.");
    await expect(service.selectConfiguration(gsc.id)).resolves.toMatchObject({
      initialized: true,
      name: "gsc",
      catalog: { selectedConfigurationId: gsc.id }
    });
  });

  it("changes an existing durable default only after selection and clears the stale selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-default-profile-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    const configPath = join(directory, "gsc.json");
    await writeConfig(configPath, {
      version: "3",
      name: "gsc",
      defaultProfile: "google-work",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { "google-work": {}, "google-personal": {} }
    });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });

    await expect(service.setDefaultProfile({ profile: "google-personal" })).rejects.toMatchObject({
      code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED"
    });
    const initial = await service.configMetadata();
    const selected = initial.catalog?.configurations.find((configuration) => configuration.name === "gsc");
    if (selected === undefined) throw new Error("Expected a discovered GSC configuration.");
    await service.selectConfiguration(selected.id);

    await expect(service.setDefaultProfile({ profile: "google-personal" })).resolves.toMatchObject({
      changed: true,
      write: true,
      profile: "google-personal"
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      defaultProfile: "google-personal",
      profiles: { "google-work": {}, "google-personal": {} }
    });
    await expect(service.health()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
  });

  it("changes an existing profile label only after selection and clears the stale selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-profile-description-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    const configPath = join(directory, "analytics.json");
    await writeConfig(configPath, {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: {
        work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { description: "Personal account", env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });

    await expect(service.setProfileDescription({
      profile: "personal",
      description: "Personal analytics"
    })).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
    const initial = await service.configMetadata();
    const selected = initial.catalog?.configurations.find((configuration) => configuration.name === "analytics");
    if (selected === undefined) throw new Error("Expected discovered analytics configuration.");
    await service.selectConfiguration(selected.id);

    await expect(service.setProfileDescription({
      profile: "personal",
      description: "Personal analytics"
    })).resolves.toMatchObject({
      changed: true,
      write: true,
      profile: "personal",
      actions: ["Set profile description for 'personal'."]
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      defaultProfile: "work",
      profiles: {
        work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { description: "Personal analytics", env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    });
    await expect(service.health()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
  });

  it("removes an existing profile only after selection and clears the stale selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-profile-removal-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    const configPath = join(directory, "analytics.json");
    await writeConfig(configPath, {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: {
        work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { description: "Personal account", env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });

    await expect(service.removeProfile({ profile: "personal" })).rejects.toMatchObject({
      code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED"
    });
    const initial = await service.configMetadata();
    const selected = initial.catalog?.configurations.find((configuration) => configuration.name === "analytics");
    if (selected === undefined) throw new Error("Expected discovered analytics configuration.");
    await service.selectConfiguration(selected.id);

    await expect(service.removeProfile({ profile: "personal" })).resolves.toMatchObject({
      changed: true,
      write: true,
      profile: "personal",
      actions: ["Removed profile 'personal'."]
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      defaultProfile: "work",
      profiles: { work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } } }
    });
    await expect(service.health()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
  });

  it("renames an existing profile only after selection and clears the stale selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-profile-rename-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    const configPath = join(directory, "analytics.json");
    await writeConfig(configPath, {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: {
        work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { description: "Personal account", env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });

    await expect(service.renameProfile({ profile: "work", newProfile: "studio" })).rejects.toMatchObject({
      code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED"
    });
    const initial = await service.configMetadata();
    const selected = initial.catalog?.configurations.find((configuration) => configuration.name === "analytics");
    if (selected === undefined) throw new Error("Expected discovered analytics configuration.");
    await service.selectConfiguration(selected.id);

    await expect(service.renameProfile({ profile: "work", newProfile: "studio" })).resolves.toMatchObject({
      changed: true,
      write: true,
      profile: "work",
      newProfile: "studio",
      actions: ["Renamed profile 'work' to 'studio'."]
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      defaultProfile: "studio",
      profiles: {
        studio: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { description: "Personal account", env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    });
    await expect(service.health()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
  });

  it("adds a static environment-backed account only after selection and clears the stale selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-environment-account-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    const configPath = join(directory, "sentry.json");
    await writeConfig(configPath, environmentProfileConfig("sentry"));
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });
    const request = {
      profile: "govalidate",
      description: "GoValidate Sentry account",
      credentialEnv: "STATIC_GOVALIDATE_ACCESS_TOKEN",
      makeDefault: true
    };

    await expect(service.addEnvironmentProfile(request)).rejects.toMatchObject({
      code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED"
    });
    const initial = await service.configMetadata();
    const selected = initial.catalog?.configurations.find((configuration) => configuration.name === "sentry");
    if (selected === undefined) throw new Error("Expected discovered Sentry configuration.");
    await service.selectConfiguration(selected.id);

    await expect(service.addEnvironmentProfile(request)).resolves.toMatchObject({
      changed: true,
      write: true,
      profile: "govalidate"
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      defaultProfile: "govalidate",
      profiles: { govalidate: { env: { STATIC_ACCESS_TOKEN: "${STATIC_GOVALIDATE_ACCESS_TOKEN}" } } }
    });
    await expect(service.addEnvironmentProfile(request)).rejects.toMatchObject({
      code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED"
    });
  });

  it("rejects an unselected Console operation before scanning its catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-unselected-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });

    await expect(service.health()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
    expect(catalogDiscoveryDiagnostic.invocations).toBe(0);
  });

  it("adds endpoint-first native OAuth only after an explicit configuration selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-discovered-oauth-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    const configPath = join(directory, "posthog.json");
    await writeConfig(configPath, {
      version: "3",
      name: "posthog-work",
      defaultProfile: "production",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { production: {} }
    });
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] },
      nativeOAuthFetch: upstream.fetch
    });

    try {
      await expect(service.addDiscoveredNativeOAuthConnection({
        profile: "production",
        upstream: "default"
      })).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
      const metadata = await service.configMetadata();
      const selected = metadata.catalog?.configurations.find((configuration) => configuration.name === "posthog-work");
      if (selected === undefined) throw new Error("Expected PostHog configuration.");
      await service.selectConfiguration(selected.id);

      await expect(service.addDiscoveredNativeOAuthConnection({
        profile: "production",
        upstream: "default"
      })).resolves.toMatchObject({ profile: "production", upstream: "default" });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        oauth: { connections: expect.any(Object) }
      });
      expect(upstream.registrationRequests()).toEqual([]);
    } finally {
      await upstream.close();
    }
  });

  it("adds another endpoint-first OAuth account only after selecting its configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-add-account-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    const configPath = join(directory, "posthog.json");
    await writeConfig(configPath, {
      version: "3",
      name: "posthog-work",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { work: {} }
    });
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory,
      nativeOAuthFetch: upstream.fetch
    });

    try {
      const request = {
        profile: "personal",
        description: "Personal analytics",
        upstream: "default",
        makeDefault: true
      };
      await expect(service.addDiscoveredNativeOAuthAccount(request)).rejects.toMatchObject({
        code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED"
      });
      const metadata = await service.configMetadata();
      const selected = metadata.catalog?.configurations.find((configuration) => configuration.name === "posthog-work");
      if (selected === undefined) throw new Error("Expected PostHog configuration.");
      await service.selectConfiguration(selected.id);

      await expect(service.addDiscoveredNativeOAuthAccount(request)).resolves.toMatchObject({
        profile: "personal",
        upstream: "default"
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        defaultProfile: "personal",
        profiles: { work: {}, personal: { description: "Personal analytics" } },
        oauth: { connections: expect.any(Object) }
      });
      await expect(service.addDiscoveredNativeOAuthAccount(request)).rejects.toMatchObject({
        code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED"
      });
      expect(upstream.registrationRequests()).toEqual([]);
    } finally {
      await upstream.close();
    }
  });

  it("omits malformed, oversized, duplicate, and nested candidates from a verified catalog", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-catalog-"));
    temporaryDirectories.push(directory);
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const gscPath = join(directory, "gsc.json");
    await writeCatalogFixture(gscPath, {
      version: "3",
      name: "gsc",
      defaultProfile: "google-work",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: {
        "google-work": {
          env: { GSC_OAUTH_CLIENT_SECRETS_FILE: "/private/client-secrets.json" }
        }
      }
    });
    await writeCatalogFixture(join(directory, "sentry.json"), {
      version: "3",
      name: "sentry",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "npx", args: ["--yes", "@sentry/mcp-server@0.36.0"] },
      profiles: { work: {} }
    });
    await writeFile(join(directory, "invalid.json"), "{not valid json", { mode: 0o600 });
    await writeCatalogFixture(join(directory, "oversized.json"), {
      version: "3",
      name: "oversized",
      description: "x".repeat(1024 * 1024),
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { default: {} }
    });
    await link(gscPath, join(directory, "gsc-duplicate.json"));
    await mkdir(join(directory, "nested"), { mode: 0o700 });
    await writeCatalogFixture(join(directory, "nested", "ignored.json"), {
      version: "3",
      name: "ignored",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { default: {} }
    });

    const catalog = await discoverConsoleConfigCatalog({
      configDirectory: directory,
      windowsAclVerifier: async () => true
    });
    expect(catalog.catalog).toMatchObject({
      discoveryState: "ready",
      discoveredCount: 5,
      readyCount: 2,
      attentionCount: 3,
      attentionReasons: [
        { reason: "invalid-configuration", count: 1 },
        { reason: "unsafe-path", count: 1 },
        { reason: "duplicate", count: 1 }
      ],
      configurations: [{ name: "gsc" }, { name: "sentry" }]
    });
    expect(catalog.configurations).toHaveLength(2);
    expect(JSON.stringify(catalog.catalog)).not.toContain(directory);
    expect(JSON.stringify(catalog.catalog)).not.toContain("client-secrets.json");
    expect(JSON.stringify(catalog.configurations)).not.toContain("client-secrets.json");
  });

  it.skipIf(process.platform === "win32")("reports hidden candidate reasons without disclosing their paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-safe-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const safePath = join(directory, "safe.json");
    await writeConfig(safePath, {
      version: "3",
      name: "safe",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { default: {} }
    });
    const groupReadablePath = join(directory, "group-readable.json");
    await writeConfig(groupReadablePath, {
      version: "3",
      name: "group-readable",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { default: {} }
    });
    await chmod(groupReadablePath, 0o640);
    await symlink(safePath, join(directory, "linked.json"));

    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });
    const metadata = await service.configMetadata();
    expect(metadata.catalog).toMatchObject({
      discoveryState: "ready",
      discoveredCount: 3,
      readyCount: 1,
      attentionCount: 2,
      attentionReasons: [
        { reason: "file-permissions", count: 1 },
        { reason: "unsafe-path", count: 1 }
      ],
      configurations: [{ name: "safe" }]
    });
    expect(metadata.catalog?.configurations).toHaveLength(1);
    expect(JSON.stringify(metadata.catalog)).not.toContain(groupReadablePath);
    expect(JSON.stringify(metadata.catalog)).not.toContain(safePath);
  });

  it("classifies a failure after trusted parsing as an invalid configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-post-read-failure-"));
    temporaryDirectories.push(directory);
    await writeCatalogFixture(join(directory, "candidate.json"), {
      version: "3",
      name: "candidate",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { default: {} }
    });
    let injectedFailure = false;

    const result = await discoverConsoleConfigCatalog({
      configDirectory: directory,
      windowsAclVerifier: async () => true,
      candidateStageObserver(event) {
        if (!injectedFailure && event.stage === "metadata" && event.outcome === "success") {
          injectedFailure = true;
          throw new Error("simulated post-read metadata failure");
        }
      }
    });

    expect(result.catalog).toMatchObject({
      discoveredCount: 1,
      readyCount: 0,
      attentionCount: 1,
      attentionReasons: [{ reason: "invalid-configuration", count: 1 }]
    });
  });

  it.skipIf(process.platform === "win32")("accepts a non-writable standard config directory when each discovered config is private", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-readable-directory-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o755);
    const configPath = join(directory, "gsc.json");
    await writeConfig(configPath, {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });

    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });
    await expect(service.configMetadata()).resolves.toMatchObject({
      initialized: false,
      catalog: { discoveryState: "ready", configurations: [{ name: "gsc" }] }
    });
  });

  it("fails closed when Windows ACL verification cannot establish a trusted standard directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-windows-acl-"));
    temporaryDirectories.push(directory);

    await expect(discoverConsoleConfigCatalog({
      configDirectory: directory,
      platform: "win32",
      windowsAclVerifier: async () => false
    })).resolves.toMatchObject({
      catalog: { discoveryState: "unavailable", configurations: [] },
      configurations: []
    });
  });

  it("batches Windows ACL verification for a trusted directory and candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-windows-acl-batch-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    const configPath = join(directory, "gsc.json");
    await writeConfig(configPath, {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { default: {} }
    });

    const legacyCalls: Array<{ readonly path: string; readonly kind: "file" | "directory" }> = [];
    const batches: Array<readonly { readonly path: string; readonly kind: "file" | "directory" }[]> = [];
    const options: ConsoleConfigCatalogDiscoveryOptions = {
      configDirectory: directory,
      platform: "win32" as const,
      windowsAclVerifier: async (path: string, kind: "file" | "directory") => {
        legacyCalls.push({ path, kind });
        return false;
      },
      windowsAclPathsVerifier: async (paths) => {
        batches.push(paths);
        return true;
      }
    };

    await expect(discoverConsoleConfigCatalog(options)).resolves.toMatchObject({
      catalog: { discoveryState: "ready", configurations: [{ name: "gsc" }] }
    });
    const [canonicalDirectory, canonicalConfigPath] = await Promise.all([realpath(directory), realpath(configPath)]);
    expect(legacyCalls).toEqual([]);
    expect(batches).toEqual([[
      { path: canonicalDirectory, kind: "directory" },
      { path: canonicalConfigPath, kind: "file" }
    ]]);
  });

  it("reports a Windows file ACL rejection without exposing the candidate path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-windows-file-acl-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "gsc.json");
    await writeConfig(configPath, {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "node", args: [] },
      profiles: { default: {} }
    });

    const result = await discoverConsoleConfigCatalog({
      configDirectory: directory,
      platform: "win32",
      windowsAclVerifier: async (_path, kind) => kind === "directory"
    });

    expect(result).toMatchObject({
      catalog: {
        discoveryState: "ready",
        discoveredCount: 1,
        readyCount: 0,
        attentionCount: 1,
        attentionReasons: [{ reason: "file-permissions", count: 1 }],
        configurations: []
      },
      configurations: []
    });
    expect(JSON.stringify(result)).not.toContain(configPath);
  });

  it.skipIf(process.platform === "win32")("revalidates a selected configuration before any later Console operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-revalidate-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const configPath = join(directory, "gsc.json");
    await writeConfig(configPath, {
      version: "3",
      name: "gsc",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });
    const initial = await service.configMetadata();
    const selected = initial.catalog?.configurations[0];
    if (selected === undefined) throw new Error("Expected a discovered configuration.");
    await service.selectConfiguration(selected.id);

    await chmod(configPath, 0o640);

    await expect(service.health()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
  });

  it.skipIf(process.platform === "win32")("requires reselection when verified configuration content changes in place", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-content-binding-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const configPath = join(directory, "gsc.json");
    await writeConfig(configPath, {
      version: "3",
      name: "verified-source",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });
    const initial = await service.configMetadata();
    const selected = initial.catalog?.configurations[0];
    if (selected === undefined) throw new Error("Expected a discovered configuration.");
    await service.selectConfiguration(selected.id);

    await writeConfig(configPath, {
      version: "3",
      name: "replacement-after-selection",
      defaultProfile: "default",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { default: {} }
    });

    await expect(service.health()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
  });

  it.skipIf(process.platform === "win32")("clears selection after a guarded configuration mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-post-mutation-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const configPath = join(directory, "remote.json");
    await writeConfig(configPath, {
      version: "2",
      name: "remote",
      defaultProfile: "default",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { default: {} }
    });
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });
    const initial = await service.configMetadata();
    const selected = initial.catalog?.configurations[0];
    if (selected === undefined) throw new Error("Expected a discovered configuration.");
    await service.selectConfiguration(selected.id);

    await service.addConnection({
      connectionRef: "oauthconn:31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c",
      profile: "default",
      upstream: "default",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: ["mcp:read"]
    });

    await expect(service.health()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
  });

  it.skipIf(process.platform === "win32")("requires explicit selection after first-run onboarding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-first-run-selection-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory
    });

    await service.onboardNativeOAuth({
      name: "first-run",
      profile: "default",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: ["mcp:read"]
    });

    await expect(service.health()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
  });
});
