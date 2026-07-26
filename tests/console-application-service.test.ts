import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleApplicationService } from "../src/console/console-application-service.js";
import { buildPresetConfig } from "../src/config/presets.js";
import {
  canonicalOAuthProfileRenameConfigPath,
} from "../src/oauth/profile-rename-transaction.js";
import {
  createOAuthConfigIdentity,
  createOAuthConnectionBinding,
  parseOAuthConnectionRef
} from "../src/oauth/connection-types.js";
import {
  discoverConsoleConfigCatalog,
  trustedConfigurationFor
} from "../src/console/console-config-catalog.js";
import { verifyWindowsConfigPathSecurity } from "../src/cli/windows-config-acl.js";
import { MiftahError } from "../src/utils/errors.js";
import { createPrivateConsoleDirectory } from "./helpers/private-console-directory.js";
import { environmentProfileConfig } from "./helpers/environment-profile-config.js";
import { createMemoryProfileRenameOAuthDependencies } from "./helpers/profile-rename-oauth-dependencies.js";
import {
  startOAuthCompatibilityProbe,
  type OAuthCompatibilityProbe
} from "./helpers/fake-remote-upstream.js";

const temporaryDirectories: string[] = [];
const oauthUpstreams: OAuthCompatibilityProbe[] = [];
const connectionRef = "oauthconn:31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c";
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function supportedKnownConnectorOptions(): {
  readonly preset: string;
  readonly credentialEnv: string;
  readonly npmPackage?: string;
  readonly dockerImage?: string;
} {
  return process.platform === "win32"
    ? {
        preset: "generic-docker",
        dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        credentialEnv: "SUPPORT_TOKEN"
      }
    : {
        preset: "generic-npx",
        npmPackage: "@scope/server@1.2.3",
        credentialEnv: "SUPPORT_TOKEN"
      };
}

function importableClientEntry(): { readonly command: string; readonly args: readonly string[] } {
  return process.platform === "win32"
    ? { command: process.execPath, args: ["server.mjs"] }
    : { command: "npx", args: ["--yes", "@posthog/mcp@1.2.3"] };
}

const manualFirstRunCompletion = {
  verification: {
    state: "not-declared",
    message: "No provider-declared safe check is available for this configuration, so Miftah did not run or invent one."
  },
  clientHandoff: {
    state: "available",
    message:
      "Next: generate a copy-only client snippet below, review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
  }
} as const;

const reviewedFirstRunCompletion = {
  verification: {
    state: "available",
    message: "A provider-declared read-only check is available, but it has not run yet."
  },
  clientHandoff: manualFirstRunCompletion.clientHandoff
} as const;

afterEach(async () => {
  if (platformDescriptor !== undefined) Object.defineProperty(process, "platform", platformDescriptor);
  await Promise.all(oauthUpstreams.splice(0).map((upstream) => upstream.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function writeConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-console-application-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "miftah.json");
  await writeFile(path, JSON.stringify({
    version: "3",
    name: "console-application-test",
    defaultProfile: "personal",
    upstream: {
      transport: "streamable-http",
      url: "https://mcp.example.test/mcp",
      headers: { "X-Private": "secretref:env://PRIVATE_HEADER" }
    },
    profiles: {
      personal: {
        description: "Personal account",
        env: { PRIVATE_TOKEN: "secretref:env://PRIVATE_PROFILE_TOKEN" }
      }
    },
    oauth: {
      connections: {
        [connectionRef]: {
          profile: "personal",
          upstream: "default",
          resource: "https://mcp.example.test/mcp",
          issuer: "https://auth.example.test",
          clientRegistration: "dynamic",
          scopes: ["read"]
        }
      }
    }
  }));
  return path;
}

async function writeSingleNamedUpstreamConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-console-named-upstream-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "miftah.json");
  await writeFile(path, JSON.stringify({
    version: "3",
    name: "console-named-upstream-test",
    defaultProfile: "personal",
    upstreams: {
      analytics: { transport: "streamable-http", url: "https://mcp.example.test/mcp" }
    },
    profiles: { personal: {} }
  }));
  return path;
}

describe("Console application service", () => {
  it.skipIf(process.platform === "win32")("binds a trusted dashboard snapshot through a configuration mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-trusted-snapshot-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const configPath = join(directory, "miftah.json");
    await writeFile(configPath, JSON.stringify({
      version: "2",
      name: "trusted-source",
      defaultProfile: "personal",
      upstream: { transport: "streamable-http", url: "https://trusted.example.test/mcp" },
      profiles: { personal: {} }
    }), { mode: 0o600 });
    await chmod(configPath, 0o600);

    const catalog = await discoverConsoleConfigCatalog({ configDirectory: directory });
    const selected = catalog.configurations[0];
    if (selected === undefined) throw new Error("Expected a trusted configuration snapshot.");
    const trustedConfiguration = trustedConfigurationFor(selected);
    if (trustedConfiguration === undefined) throw new Error("Expected trusted configuration bytes.");
    const service = new ConsoleApplicationService(selected.path, {
      trustedConfiguration
    });

    await writeFile(configPath, JSON.stringify({
      version: "2",
      name: "replacement-after-verification",
      defaultProfile: "personal",
      upstream: { transport: "streamable-http", url: "https://replacement.example.test/mcp" },
      profiles: { personal: {} }
    }), { mode: 0o600 });
    await chmod(configPath, 0o600);

    await expect(service.health()).resolves.toMatchObject({ config: { name: "trusted-source" } });
    await expect(service.addConnection({
      connectionRef,
      profile: "personal",
      upstream: "default",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: ["read"]
    })).rejects.toMatchObject({ code: "CONFIG_MIGRATION_WRITE_FAILED" });
  });

  it("creates a validated first-run native OAuth profile and connection without accepting secret material", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-first-run-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const configPath = join(privateParent, "miftah", "miftah.json");
    const service = new ConsoleApplicationService(configPath, {
      generateConnectionRef: () => "31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c",
      launcher: { command: process.execPath, args: [join(process.cwd(), "dist", "cli", "main.js"), "serve"] }
    });

    await expect(service.configMetadata()).resolves.toEqual({
      initialized: false,
      restartRequiredForExistingClients: true
    });

    const created = await service.onboardNativeOAuth({
      name: "posthog-work",
      profile: "production",
      description: "Production account",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: ["openid", "analytics:read"]
    });
    expect(created).toMatchObject({
      connectionRef,
      profile: "production",
      upstream: "default",
      resource: "https://mcp.example.test/mcp",
      completion: {
        verification: {
          state: "authorization-pending",
          message: "No browser authorization completed during setup. Connect later to begin the provider's authorization flow."
        },
        clientHandoff: manualFirstRunCompletion.clientHandoff
      }
    });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config).toEqual({
      version: "3",
      name: "posthog-work",
      defaultProfile: "production",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { production: { description: "Production account" } },
      oauth: {
        connections: {
          [connectionRef]: {
            profile: "production",
            upstream: "default",
            resource: "https://mcp.example.test/mcp",
            issuer: "https://auth.example.test",
            clientRegistration: "dynamic",
            scopes: ["openid", "analytics:read"]
          }
        }
      }
    });
    expect(JSON.stringify(config)).not.toMatch(/token|secret|password/iu);
    if (process.platform === "win32") {
      await expect(verifyWindowsConfigPathSecurity(configPath, "file")).resolves.toBe(true);
    }

    const snippets = await service.clientSnippets("claude-desktop");
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toMatchObject({ client: "claude-desktop" });
    const snippetConfig = JSON.parse(snippets[0]?.json ?? "") as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(snippetConfig.mcpServers["posthog-work"]?.args).toContain(configPath);
    expect(JSON.stringify(snippets)).not.toContain("auth.example.test");

    await expect(service.onboardNativeOAuth({
      name: "replacement",
      profile: "other",
      resource: "https://other.example.test/mcp",
      issuer: "https://auth.other.example.test",
      clientRegistration: "dynamic",
      scopes: []
    })).rejects.toMatchObject({ code: "CONFIG_ALREADY_EXISTS" });
  });

  it("discovers a first-run native OAuth binding from the endpoint before writing the configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-discovered-native-oauth-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const configPath = join(privateParent, "miftah", "miftah.json");
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    oauthUpstreams.push(upstream);
    const service = new ConsoleApplicationService(configPath, {
      generateConnectionRef: () => "31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c",
      nativeOAuthFetch: upstream.fetch
    });

    const created = await service.onboardDiscoveredNativeOAuth({
      name: "posthog-work",
      profile: "production",
      description: "Production account",
      resource: upstream.streamableHttpUrl
    });

    expect(created).toMatchObject({
      connectionRef,
      profile: "production",
      upstream: "default",
      resource: "https://mcp.example.test/mcp",
      actions: [
        "Created profile 'production'.",
        "Discovered standards-based OAuth for profile 'production'.",
        "Added OAuth connection for profile 'production' and upstream 'default'."
      ],
      completion: {
        verification: {
          state: "authorization-pending",
          message: "No browser authorization completed during setup. Connect later to begin the provider's authorization flow."
        },
        clientHandoff: manualFirstRunCompletion.clientHandoff
      }
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      oauth: {
        connections: {
          [connectionRef]: {
            issuer: "https://mcp.example.test",
            clientRegistration: "dynamic",
            scopes: ["mcp:tools"]
          }
        }
      }
    });
    expect(upstream.registrationRequests()).toEqual([]);
  });

  it("discovers OAuth from an existing selected Streamable HTTP upstream before adding its connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-existing-native-oauth-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "miftah.json");
    await writeFile(configPath, JSON.stringify({
      version: "3",
      name: "posthog-work",
      defaultProfile: "production",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { production: { description: "Production analytics" } }
    }, null, 2));
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    oauthUpstreams.push(upstream);
    const service = new ConsoleApplicationService(configPath, {
      generateConnectionRef: () => "31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c",
      nativeOAuthFetch: upstream.fetch
    });

    await expect(service.addDiscoveredNativeOAuthConnection({
      profile: "production",
      upstream: "default"
    })).resolves.toMatchObject({
      connectionRef,
      profile: "production",
      upstream: "default",
      resource: "https://mcp.example.test/mcp"
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      oauth: {
        connections: {
          [connectionRef]: {
            profile: "production",
            upstream: "default",
            resource: "https://mcp.example.test/mcp",
            issuer: "https://mcp.example.test",
            clientRegistration: "dynamic",
            scopes: ["mcp:tools"]
          }
        }
      }
    });
    expect(upstream.discoveryRequests()).toEqual([
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server"
    ]);
    expect(upstream.registrationRequests()).toEqual([]);
  });

  it("adds another native OAuth account profile atomically from the existing upstream", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-add-native-oauth-account-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "miftah.json");
    await writeFile(configPath, JSON.stringify({
      version: "3",
      name: "posthog-work",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { work: { description: "Work analytics" } },
      oauth: {
        connections: {
          [connectionRef]: {
            profile: "work",
            upstream: "default",
            resource: "https://mcp.example.test/mcp",
            issuer: "https://mcp.example.test",
            clientRegistration: "dynamic",
            scopes: ["mcp:tools"]
          }
        }
      }
    }, null, 2));
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    oauthUpstreams.push(upstream);
    const service = new ConsoleApplicationService(configPath, {
      generateConnectionRef: () => "f7a93c2d-778e-48e2-9d52-56a9d3b577cf",
      nativeOAuthFetch: upstream.fetch
    });

    await expect(service.addDiscoveredNativeOAuthAccount({
      profile: "personal",
      description: "Personal analytics",
      upstream: "default",
      makeDefault: true
    })).resolves.toMatchObject({
      connectionRef: "oauthconn:f7a93c2d-778e-48e2-9d52-56a9d3b577cf",
      profile: "personal",
      upstream: "default",
      resource: "https://mcp.example.test/mcp",
      actions: [
        "Created profile 'personal'.",
        "Discovered standards-based OAuth for profile 'personal'.",
        "Added OAuth connection for profile 'personal' and upstream 'default'.",
        "Set durable default profile to 'personal'."
      ]
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      defaultProfile: "personal",
      profiles: {
        work: { description: "Work analytics" },
        personal: { description: "Personal analytics" }
      },
      oauth: {
        connections: {
          [connectionRef]: { profile: "work" },
          "oauthconn:f7a93c2d-778e-48e2-9d52-56a9d3b577cf": {
            profile: "personal",
            scopes: ["mcp:tools"]
          }
        }
      }
    });
    expect(upstream.registrationRequests()).toEqual([]);
    await expect(service.auditRecords(10)).resolves.toContainEqual(expect.objectContaining({
      operation: "console/oauth-profile-add",
      profile: "personal",
      upstream: "default",
      status: "success"
    }));
  });

  it("rejects an existing non-Streamable upstream before it can fetch OAuth metadata or write a connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-non-native-upstream-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "miftah.json");
    const original = JSON.stringify({
      version: "3",
      name: "local-tools",
      defaultProfile: "production",
      upstream: { transport: "stdio", command: process.execPath, args: ["provider.mjs"] },
      profiles: { production: {} }
    }, null, 2);
    await writeFile(configPath, original);
    const fetch = async (): Promise<Response> => {
      throw new Error("metadata fetch must not run");
    };
    const service = new ConsoleApplicationService(configPath, { nativeOAuthFetch: fetch });

    await expect(service.addDiscoveredNativeOAuthConnection({
      profile: "production",
      upstream: "default"
    })).rejects.toMatchObject({ code: "OAUTH_RESOURCE_INVALID" });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("creates a first-run known connector through the shared preset setup path", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-preset-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const configPath = join(privateParent, "miftah", "miftah.json");
    const service = new ConsoleApplicationService(configPath);
    const { preset, ...options } = supportedKnownConnectorOptions();

    const created = await service.onboardPreset({
      name: "support-tools",
      preset,
      ...options
    });

    expect(created).toEqual({
      changed: true,
      write: true,
      name: "support-tools",
      defaultProfile: "default",
      profileCount: 1,
      actions: [`Created Miftah configuration 'support-tools' from preset '${preset}'.`],
      completion: manualFirstRunCompletion
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(
      buildPresetConfig("support-tools", preset, options)
    );
    await expect(service.onboardPreset({
      name: "replacement",
      preset,
      ...options
    })).rejects.toMatchObject({ code: "CONFIG_ALREADY_EXISTS" });
  });

  it("previews a first-run connector without writing configuration or audit state", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-preset-preview-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const configPath = join(privateParent, "miftah", "miftah.json");
    const service = new ConsoleApplicationService(configPath);
    const { preset, ...options } = supportedKnownConnectorOptions();

    await expect(service.previewPreset({
      name: "support-tools",
      preset,
      ...options
    })).resolves.toEqual({
      changed: false,
      write: false,
      name: "support-tools",
      defaultProfile: "default",
      profileCount: 1,
      actions: [`Review Miftah configuration 'support-tools' from preset '${preset}' before creating it.`],
      configuration: {
        schemaVersion: 1,
        name: "support-tools",
        version: "3",
        defaultProfile: "default",
        profiles: ["default"],
        profileCount: 1,
        upstreams: [{ name: "default", transport: "stdio", kind: "local-process" }],
        sensitiveValues: "omitted",
        publication: "new-file-only"
      }
    });

    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const serialized = JSON.stringify(await service.previewPreset({
      name: "support-tools",
      preset,
      ...options
    }));
    expect(serialized).not.toContain("SUPPORT_TOKEN");
    expect(serialized).not.toContain(privateParent);
  });

  it("refuses a Windows npx preset before it can create a Console configuration", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const root = await mkdtemp(join(tmpdir(), "miftah-console-windows-npx-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "miftah", "miftah.json");
    const service = new ConsoleApplicationService(configPath);

    await expect(service.onboardPreset({
      name: "unsafe-npx",
      preset: "generic-npx",
      npmPackage: "@scope/server@1.2.3"
    })).rejects.toMatchObject({
      code: "CONFIG_SCHEMA_INVALID",
      message: expect.stringContaining("unavailable on Windows")
    });
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates an explicitly acknowledged local stdio configuration through the same preset path", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-local-stdio-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const configPath = join(privateParent, "miftah", "miftah.json");
    const service = new ConsoleApplicationService(configPath);
    const localCommand = process.platform === "win32" ? process.execPath : "node";

    await expect(service.onboardPreset({
      name: "local-tools",
      preset: "local-stdio",
      localCommand,
      args: ["server.mjs", "--stdio", "$pageview"],
      cwd: root,
      credentialEnv: "LOCAL_MCP_TOKEN",
      acceptLocalCommand: true
    })).resolves.toEqual({
      changed: true,
      write: true,
      name: "local-tools",
      defaultProfile: "default",
      profileCount: 1,
      actions: ["Created Miftah configuration 'local-tools' from preset 'local-stdio'."],
      completion: manualFirstRunCompletion
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      upstream: { transport: "stdio", command: localCommand, args: ["server.mjs", "--stdio", "$pageview"], cwd: root },
      profiles: { default: { env: { LOCAL_MCP_TOKEN: "${LOCAL_MCP_TOKEN}" }, policy: "readonly" } },
      tooling: { unknownToolRisk: "destructive" }
    });
  });

  it("creates a first-run configuration from one explicitly selected local stdio client entry without accepting credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-client-entry-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const configPath = join(privateParent, "miftah", "miftah.json");
    const service = new ConsoleApplicationService(configPath);
    const entry = importableClientEntry();

    await expect(service.onboardClientEntry({
      name: "posthog-work",
      entry: "posthog",
      document: JSON.stringify({
        mcpServers: {
          posthog: entry
        }
      })
    })).resolves.toEqual({
      changed: true,
      write: true,
      name: "posthog-work",
      defaultProfile: "default",
      profileCount: 1,
      actions: ["Created Miftah configuration 'posthog-work' from one selected local stdio client entry."],
      completion: manualFirstRunCompletion
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      name: "posthog-work",
      upstream: { transport: "stdio", command: entry.command, args: entry.args },
      profiles: { default: { policy: "readonly" } },
      tooling: { unknownToolRisk: "destructive" }
    });
  });

  it("creates a first-run configuration from one explicitly selected HTTPS remote client entry without OAuth discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-client-entry-remote-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const configPath = join(privateParent, "miftah", "miftah.json");
    const service = new ConsoleApplicationService(configPath);

    await expect(service.onboardClientEntry({
      name: "remote-analytics",
      entry: "analytics",
      document: JSON.stringify({
        servers: {
          analytics: { type: "http", url: "https://mcp.example.test/mcp" }
        }
      })
    })).resolves.toEqual({
      changed: true,
      write: true,
      name: "remote-analytics",
      defaultProfile: "default",
      profileCount: 1,
      actions: [
        "Created Miftah configuration 'remote-analytics' from one selected HTTPS remote client entry without OAuth discovery or an upstream call."
      ],
      completion: manualFirstRunCompletion
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      name: "remote-analytics",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { default: { policy: "readonly" } },
      tooling: { unknownToolRisk: "destructive" }
    });
  });

  it("gives a bounded advanced-manual recovery code for an entry outside the static launch grammar", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-client-entry-static-launch-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const configPath = join(privateParent, "miftah", "miftah.json");
    const service = new ConsoleApplicationService(configPath);

    await expect(service.onboardClientEntry({
      name: "posthog-work",
      entry: "posthog",
      document: JSON.stringify({
        mcpServers: {
          posthog: {
            command: "npx",
            args: ["--yes", "@posthog/mcp@1.2.3", "--project", "craftmyletter"]
          }
        }
      })
    })).rejects.toMatchObject({
      code: "CLIENT_ENTRY_STATIC_LAUNCH_UNSUPPORTED",
      message: "CLIENT_ENTRY_STATIC_LAUNCH_UNSUPPORTED: use advanced manual setup for custom arguments or credentials"
    });
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the same multi-account GSC configuration as the guided CLI path", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-gsc-preset-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const configPath = join(privateParent, "miftah", "gsc.json");
    const service = new ConsoleApplicationService(configPath);
    const govalidateSecrets = join(root, "govalidate-client-secrets.json");
    const craftmyletterSecrets = join(root, "craftmyletter-client-secrets.json");
    const request = {
      name: "gsc",
      preset: "google-search-console",
      googleSearchConsoleProfiles: [
        {
          name: "google-govalidate",
          description: "GoValidate Google account",
          oauthClientSecretsFile: govalidateSecrets
        },
        {
          name: "google-craftmyletter",
          description: "CraftMyLetter Google account",
          oauthClientSecretsFile: craftmyletterSecrets
        }
      ],
      defaultProfile: "google-craftmyletter"
    } as const;

    await expect(service.onboardPreset(request)).resolves.toEqual({
      changed: true,
      write: true,
      name: "gsc",
      defaultProfile: "google-craftmyletter",
      profileCount: 2,
      actions: ["Created Miftah configuration 'gsc' from preset 'google-search-console'."],
      completion: reviewedFirstRunCompletion
    });
    const { name, preset, ...options } = request;
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(buildPresetConfig(name, preset, options, {
      configurationPath: configPath
    }));
  });

  it("adds a provider-owned GSC account through the shared guarded lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-add-provider-account-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "gsc.json");
    const firstSecrets = join(root, "google-work-client-secrets.json");
    const secondSecrets = join(root, "google-personal-client-secrets.json");
    const thirdSecrets = join(root, "google-third-client-secrets.json");
    await writeFile(configPath, `${JSON.stringify(buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        { name: "google-work", oauthClientSecretsFile: firstSecrets },
        { name: "google-personal", oauthClientSecretsFile: secondSecrets }
      ],
      defaultProfile: "google-work"
    }, { configurationPath: configPath }), null, 2)}\n`, { mode: 0o600 });
    const service = new ConsoleApplicationService(configPath);

    await expect(service.addProviderAccount({
      profile: "google-third",
      description: "Third Google account",
      credentialFile: thirdSecrets,
      makeDefault: true
    })).resolves.toEqual({
      changed: true,
      write: true,
      adapter: "Google Search Console",
      profile: "google-third",
      actions: [
        "Created provider-owned account profile 'google-third'.",
        "Set durable default profile to 'google-third'."
      ]
    });
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      readonly defaultProfile: string;
      readonly profiles: Record<string, { readonly env: { readonly GSC_CONFIG_DIR: string } }>;
    };
    expect(config.defaultProfile).toBe("google-third");
    expect(Object.keys(config.profiles)).toHaveLength(3);
    expect(new Set(Object.values(config.profiles).map((profile) => profile.env.GSC_CONFIG_DIR)).size).toBe(3);
    await expect(service.auditRecords(10)).resolves.toContainEqual(expect.objectContaining({
      operation: "console/provider-profile-add",
      profile: "google-third",
      status: "success"
    }));
    expect(JSON.stringify(await service.auditRecords(10))).not.toContain(thirdSecrets);
  });

  it("adds an environment-backed account through the shared guarded lifecycle without reading a credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-add-environment-account-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "sentry.json");
    await writeFile(configPath, `${JSON.stringify(environmentProfileConfig("sentry"), null, 2)}\n`, { mode: 0o600 });
    const service = new ConsoleApplicationService(configPath);

    await expect(service.addEnvironmentProfile({
      profile: "govalidate",
      description: "GoValidate Sentry account",
      credentialEnv: "STATIC_GOVALIDATE_ACCESS_TOKEN",
      makeDefault: true
    })).resolves.toEqual({
      changed: true,
      write: true,
      profile: "govalidate",
      actions: [
        "Created environment-backed account profile 'govalidate'.",
        "Enabled required profile-switch confirmation.",
        "Required explicit selection for destructive tools.",
        "Set durable default profile to 'govalidate'."
      ]
    });
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      readonly defaultProfile: string;
      readonly profiles: Record<string, { readonly env?: Record<string, string> }>;
    };
    expect(config.defaultProfile).toBe("govalidate");
    expect(config.profiles.govalidate).toEqual({
      description: "GoValidate Sentry account",
      env: { STATIC_ACCESS_TOKEN: "${STATIC_GOVALIDATE_ACCESS_TOKEN}" },
      policy: "readonly"
    });
    await expect(service.auditRecords(10)).resolves.toContainEqual(expect.objectContaining({
      operation: "console/environment-profile-add",
      profile: "govalidate",
      status: "success"
    }));
  });

  it("changes the durable default profile without altering existing provider accounts", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-default-profile-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "gsc.json");
    const firstSecrets = join(root, "google-work-client-secrets.json");
    const secondSecrets = join(root, "google-personal-client-secrets.json");
    const original = buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        { name: "google-work", oauthClientSecretsFile: firstSecrets },
        { name: "google-personal", oauthClientSecretsFile: secondSecrets }
      ],
      defaultProfile: "google-work"
    }, { configurationPath: configPath });
    await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
    const service = new ConsoleApplicationService(configPath);

    await expect(service.setDefaultProfile({ profile: "google-personal" })).resolves.toEqual({
      changed: true,
      write: true,
      profile: "google-personal",
      actions: ["Set durable default profile to 'google-personal'."]
    });

    const updated = JSON.parse(await readFile(configPath, "utf8")) as typeof original;
    expect(updated.defaultProfile).toBe("google-personal");
    expect(updated.profiles).toEqual(original.profiles);
    await expect(service.auditRecords(10)).resolves.toContainEqual(expect.objectContaining({
      operation: "console/default-profile-set",
      profile: "google-personal",
      status: "success"
    }));
  });

  it("changes a non-secret profile label without exposing it in the Console report or lifecycle audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-profile-description-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "analytics.json");
    await writeFile(configPath, `${JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: ["provider.mjs"] },
      profiles: {
        work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { description: "Personal account", env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    }, null, 2)}\n`, { mode: 0o600 });
    const service = new ConsoleApplicationService(configPath);

    const report = await service.setProfileDescription({
      profile: "personal",
      description: "Personal analytics"
    });

    expect(report).toEqual({
      changed: true,
      write: true,
      profile: "personal",
      actions: ["Set profile description for 'personal'."]
    });
    expect(JSON.stringify(report)).not.toContain("Personal analytics");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      defaultProfile: "work",
      profiles: {
        work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { description: "Personal analytics", env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    });
    const audit = await service.auditRecords(10);
    expect(audit).toContainEqual(expect.objectContaining({
      operation: "console/profile-description-set-intent",
      profile: "personal",
      status: "success"
    }));
    expect(audit).toContainEqual(expect.objectContaining({
      operation: "console/profile-description-set",
      profile: "personal",
      status: "success"
    }));
    expect(JSON.stringify(audit)).not.toContain("Personal analytics");
  });

  it("removes an unreferenced profile through the shared audited lifecycle without exposing its credential reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-profile-removal-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "analytics.json");
    await writeFile(configPath, `${JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: ["provider.mjs"] },
      profiles: {
        work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { description: "Personal account", env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    }, null, 2)}\n`, { mode: 0o600 });
    const service = new ConsoleApplicationService(configPath);

    const report = await service.removeProfile({ profile: "personal" });

    expect(report).toEqual({
      changed: true,
      write: true,
      profile: "personal",
      actions: ["Removed profile 'personal'."]
    });
    expect(JSON.stringify(report)).not.toContain("PERSONAL_API_KEY");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      defaultProfile: "work",
      profiles: { work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } } }
    });
    const audit = await service.auditRecords(10);
    expect(audit).toContainEqual(expect.objectContaining({
      operation: "console/profile-remove-intent",
      profile: "personal",
      status: "success"
    }));
    expect(audit).toContainEqual(expect.objectContaining({
      operation: "console/profile-remove",
      profile: "personal",
      status: "success"
    }));
    expect(JSON.stringify(audit)).not.toContain("PERSONAL_API_KEY");
  });

  it("renames a profile through the shared audited lifecycle without exposing its credential reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-profile-rename-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "analytics.json");
    await writeFile(configPath, `${JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: ["provider.mjs"] },
      profiles: {
        work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { description: "Personal account", env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    }, null, 2)}\n`, { mode: 0o600 });
    const service = new ConsoleApplicationService(configPath);

    const report = await service.renameProfile({ profile: "work", newProfile: "studio" });

    expect(report).toEqual({
      changed: true,
      write: true,
      profile: "work",
      newProfile: "studio",
      actions: ["Renamed profile 'work' to 'studio'."]
    });
    expect(JSON.stringify(report)).not.toContain("WORK_API_KEY");
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      defaultProfile: "studio",
      profiles: {
        studio: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { description: "Personal account", env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    });
    const audit = await service.auditRecords(10);
    expect(audit).toContainEqual(expect.objectContaining({
      operation: "console/profile-rename-intent",
      profile: "work",
      name: "studio",
      status: "success"
    }));
    expect(audit).toContainEqual(expect.objectContaining({
      operation: "console/profile-rename",
      profile: "work",
      name: "studio",
      status: "success"
    }));
    expect(JSON.stringify(audit)).not.toContain("WORK_API_KEY");
  });

  it("renames a native OAuth profile through the Console application service", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-native-oauth-profile-rename-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "analytics.json");
    await writeFile(configPath, `${JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: "https://mcp.example.com/mcp" },
      profiles: { work: {}, personal: {} },
      oauth: {
        connections: {
          "oauthconn:11111111-1111-4111-8111-111111111111": {
            profile: "work",
            upstream: "default",
            resource: "https://mcp.example.com/mcp",
            issuer: "https://auth.example.com",
            clientRegistration: "dynamic",
            scopes: ["openid"]
          }
        }
      }
    }, null, 2)}\n`, { mode: 0o600 });
    const oauth = createMemoryProfileRenameOAuthDependencies();
    const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
    const from = createOAuthConnectionBinding({
      configIdentity: createOAuthConfigIdentity(canonicalConfigPath),
      connectionRef: parseOAuthConnectionRef("oauthconn:11111111-1111-4111-8111-111111111111"),
      profile: "work",
      upstream: "default",
      resource: "https://mcp.example.com/mcp",
      issuer: "https://auth.example.com",
      clientRegistration: "dynamic",
      scopes: ["openid"]
    });
    await oauth.credentials.save(from, { accessToken: "fixture-console-profile-rename-token" });
    await oauth.registry.create(from);
    const service = new ConsoleApplicationService(configPath, { oauthProfileRename: oauth.dependencies });

    await expect(service.renameProfile({ profile: "work", newProfile: "studio" })).resolves.toMatchObject({
      changed: true,
      profile: "work",
      newProfile: "studio"
    });
    const to = createOAuthConnectionBinding({
      configIdentity: from.configIdentity,
      connectionRef: from.connectionRef,
      profile: "studio",
      upstream: from.upstream,
      resource: from.canonicalResource,
      issuer: from.issuer,
      clientRegistration: from.clientRegistration,
      scopes: from.scopes
    });
    await expect(oauth.credentials.load(from)).resolves.toBeUndefined();
    await expect(oauth.credentials.load(to)).resolves.toEqual({ accessToken: "fixture-console-profile-rename-token" });
    await expect(oauth.registry.snapshot(to)).resolves.toMatchObject({ binding: to });
  });

  it("returns allowlisted metadata and audit-records each exact OAuth lifecycle mutation", async () => {
    const calls: string[] = [];
    const configPath = await writeConfig();
    const service = new ConsoleApplicationService(configPath, {
      commandService: {
        list: async () => [],
        status: async ({ connectionRef: selected }) => ({ connectionRef: selected, credentialState: "missing" }),
        connect: async ({ connectionRef: selected }) => {
          calls.push(`connect:${selected}`);
          return { ok: true };
        },
        reauth: async ({ connectionRef: selected }) => {
          calls.push(`reauth:${selected}`);
          return { ok: true };
        },
        test: async ({ connectionRef: selected }) => ({ connectionRef: selected, ok: true }),
        disconnect: async ({ connectionRef: selected }) => {
          calls.push(`disconnect:${selected}`);
          return { credentialState: "missing" };
        }
      }
    });

    const metadata = await service.configMetadata();
    expect(metadata).toMatchObject({
      name: "console-application-test",
      profiles: [{ name: "personal", description: "Personal account" }],
      upstreams: [{ name: "default", transport: "streamable-http" }],
      oauthConnectionCount: 1
    });
    expect(JSON.stringify(metadata)).not.toContain("PRIVATE_HEADER");
    expect(JSON.stringify(metadata)).not.toContain("PRIVATE_PROFILE_TOKEN");

    await expect(service.connect("__proto__")).rejects.toMatchObject({ code: "OAUTH_CONNECTION_INVALID" });
    expect(calls).toEqual([]);
    expect(await service.auditRecords(10)).toEqual([]);

    await service.connect(connectionRef);
    await service.reauth(connectionRef);
    await service.disconnect(connectionRef);
    expect(calls).toEqual([
      `connect:${connectionRef}`,
      `reauth:${connectionRef}`,
      `disconnect:${connectionRef}`
    ]);

    const records = await service.auditRecords(10);
    expect(records).toEqual([
      expect.objectContaining({ operation: "console/oauth-connect", status: "success", profile: "personal" }),
      expect.objectContaining({ operation: "console/oauth-reauth", status: "success", profile: "personal" }),
      expect.objectContaining({ operation: "console/oauth-disconnect", status: "success", profile: "personal" })
    ]);
    expect(JSON.stringify(records)).not.toContain(connectionRef);
    expect(JSON.stringify(records)).not.toContain("auth.example.test");
  });

  it("uses the shared readiness service and records the Console action without launching an unsupported provider", async () => {
    const configPath = await writeConfig();
    const service = new ConsoleApplicationService(configPath);

    await expect(service.profileReadiness({ profile: "personal" })).resolves.toEqual({
      status: "unsupported",
      profile: "personal",
      upstream: "default",
      safeRead: { status: "unavailable", errorCode: "PROFILE_READINESS_UNSUPPORTED" },
      identity: { status: "not-checked" }
    });
    await expect(service.auditRecords(10)).resolves.toEqual([
      expect.objectContaining({
        operation: "console/profile-readiness",
        name: "profile",
        profile: "personal",
        upstream: "default",
        status: "failure",
        errorCode: "PROFILE_READINESS_UNSUPPORTED"
      })
    ]);
  });

  it("audits the resolved named upstream rather than inventing a default target", async () => {
    const service = new ConsoleApplicationService(await writeSingleNamedUpstreamConfig());

    await expect(service.profileReadiness({ profile: "personal" })).resolves.toMatchObject({
      status: "unsupported",
      profile: "personal",
      upstream: "analytics"
    });
    await expect(service.auditRecords(10)).resolves.toEqual([
      expect.objectContaining({
        operation: "console/profile-readiness",
        profile: "personal",
        upstream: "analytics",
        errorCode: "PROFILE_READINESS_UNSUPPORTED"
      })
    ]);
  });

  it("returns live redacted connection state for dashboard connection cards", async () => {
    const configPath = await writeConfig();
    const status = {
      connectionRef,
      profile: "personal",
      upstream: "default",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: ["read"],
      credentialState: "disconnected",
      identityState: "unavailable"
    };
    let listCalls = 0;
    const service = new ConsoleApplicationService(configPath, {
      commandService: {
        list: async () => {
          listCalls += 1;
          return [status];
        },
        status: async () => status,
        connect: async () => status,
        reauth: async () => status,
        test: async () => ({ ok: true }),
        disconnect: async () => status
      }
    });

    await expect(service.listConnections()).resolves.toEqual([status]);
    expect(listCalls).toBe(1);
  });

  it("surfaces a stable diagnostic when live connection state is unavailable", async () => {
    const configPath = await writeConfig();
    const unavailable = new MiftahError(
      "OAUTH_CONNECTION_STORE_UNAVAILABLE",
      "sensitive provider detail that must not cross the Console boundary"
    );
    const service = new ConsoleApplicationService(configPath, {
      commandService: {
        list: async () => Promise.reject(unavailable),
        status: async () => Promise.reject(unavailable),
        connect: async () => Promise.reject(unavailable),
        reauth: async () => Promise.reject(unavailable),
        test: async () => Promise.reject(unavailable),
        disconnect: async () => Promise.reject(unavailable)
      }
    });

    const connections = await service.listConnections();
    expect(connections).toEqual([
      expect.objectContaining({
        connectionRef,
        profile: "personal",
        upstream: "default",
        credentialState: "unsupported",
        identityState: "unavailable",
        statusErrorCode: "OAUTH_CONNECTION_STORE_UNAVAILABLE"
      })
    ]);
    expect(JSON.stringify(connections)).not.toContain("sensitive provider detail");
  });

  it("refuses a configuration mutation before side effects when the required Console audit is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-audit-failure-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = JSON.stringify({
      version: "2",
      name: "console-audit-failure",
      defaultProfile: "personal",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { personal: {} }
    });
    await writeFile(configPath, original);
    await writeFile(join(directory, ".miftah"), "blocks the required audit directory");

    const service = new ConsoleApplicationService(configPath);
    await expect(service.addConnection({
      connectionRef,
      profile: "personal",
      upstream: "default",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: ["read"]
    })).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });

    expect(await readFile(configPath, "utf8")).toBe(original);
    const health = await service.health();
    expect(health).toMatchObject({
      audit: {
        enabled: true,
        state: "failed",
        lastFailure: { errorCode: "AUDIT_WRITE_FAILED" }
      }
    });
    expect(JSON.stringify(health)).not.toContain(directory);
  });
});
