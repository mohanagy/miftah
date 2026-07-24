import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverConsoleConfigCatalog } from "../src/console/console-config-catalog.js";
import { ConsoleDashboardApplicationService } from "../src/console/console-dashboard-application-service.js";
import { verifyWindowsConfigPathSecurity } from "../src/cli/windows-config-acl.js";
import {
  createPrivateConsoleDirectory,
  writePrivateConsoleFile
} from "./helpers/private-console-directory.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function writeConfig(path: string, value: unknown): Promise<void> {
  await writePrivateConsoleFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeCatalogFixture(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

describe("Console dashboard application service", () => {
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
    await writeConfig(join(directory, "sentry.json"), {
      version: "3",
      name: "sentry",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "npx", args: ["--yes", "@sentry/mcp-server@0.36.0"] },
      profiles: { work: {} }
    });

    const service = new ConsoleDashboardApplicationService({
      defaultConfigPath: join(directory, "miftah.json"),
      configDirectory: directory,
      launcher: { command: process.execPath, args: ["serve"] }
    });

    const initial = await service.configMetadata();
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

  it("requires explicit selection before native OAuth onboarding when a configuration exists", async () => {
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

    await expect(service.onboardNativeOAuth({
      name: "must-not-create-a-second-config",
      profile: "default",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: []
    })).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
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

    await expect(service.onboardPreset({
      name: "support-tools",
      preset: "generic-npx",
      npmPackage: "@scope/server@1.2.3"
    })).resolves.toMatchObject({ name: "support-tools", defaultProfile: "default" });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      name: "support-tools",
      upstream: { args: ["--yes", "@scope/server@1.2.3"] }
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
      configurations: [{ name: "gsc" }, { name: "sentry" }]
    });
    expect(catalog.configurations).toHaveLength(2);
    expect(JSON.stringify(catalog.catalog)).not.toContain(directory);
    expect(JSON.stringify(catalog.catalog)).not.toContain("client-secrets.json");
    expect(JSON.stringify(catalog.configurations)).not.toContain("client-secrets.json");
  });

  it.skipIf(process.platform === "win32")("omits symbolic and group-readable candidates without disclosing their paths", async () => {
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
      configurations: [{ name: "safe" }]
    });
    expect(metadata.catalog?.configurations).toHaveLength(1);
    expect(JSON.stringify(metadata.catalog)).not.toContain(groupReadablePath);
    expect(JSON.stringify(metadata.catalog)).not.toContain(safePath);
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
