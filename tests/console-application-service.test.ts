import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleApplicationService } from "../src/console/console-application-service.js";

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
  it("creates a validated first-run native OAuth profile and connection without accepting secret material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-first-run-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
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

    const snippets = await service.clientSnippets("claude-desktop");
    expect(snippets).toEqual([
      expect.objectContaining({
        client: "claude-desktop",
        json: expect.stringContaining(configPath)
      })
    ]);
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
