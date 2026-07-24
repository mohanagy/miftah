import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleApplicationService } from "../src/console/console-application-service.js";
import {
  discoverConsoleConfigCatalog,
  trustedConfigurationFor
} from "../src/console/console-config-catalog.js";
import { verifyWindowsConfigPathSecurity } from "../src/cli/windows-config-acl.js";
import { MiftahError } from "../src/utils/errors.js";
import { createPrivateConsoleDirectory } from "./helpers/private-console-directory.js";

const temporaryDirectories: string[] = [];
const connectionRef = "oauthconn:31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c";

afterEach(async () => {
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
      resource: "https://mcp.example.test/mcp"
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
