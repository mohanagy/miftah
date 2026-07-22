import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  planOAuthConnectionAdd,
  runConnectionAddCommand,
  type ConnectionApplicationAuditEvent,
  type ConnectionApplicationAuditSink
} from "../src/oauth/connection-application-service.js";

const connectionRef = "oauthconn:2ef70816-b236-4bed-83fb-2c6a7dad26d3";
const temporaryDirectories: string[] = [];

function versionTwoConfig(): Record<string, unknown> {
  return {
    version: "2",
    name: "analytics",
    description: "preserve me",
    defaultProfile: "production",
    upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
    profiles: { production: {} },
    secrets: { allowPlaintextSecrets: false }
  };
}

const request = {
  profile: "production",
  upstream: "default",
  issuer: "https://auth.example.test",
  clientRegistration: "dynamic",
  scopes: ["openid", "profile"]
};

class MemoryAuditSink implements ConnectionApplicationAuditSink {
  readonly events: ConnectionApplicationAuditEvent[] = [];
  prepared = false;

  async ensureWritable(): Promise<void> {
    this.prepared = true;
  }

  async record(event: ConnectionApplicationAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OAuth connection application service", () => {
  it("plans a v2-to-v3 connection addition without mutating the caller's configuration", () => {
    const input = versionTwoConfig();
    const original = structuredClone(input);

    const plan = planOAuthConnectionAdd(input, request, connectionRef);

    expect(input).toEqual(original);
    expect(plan.connectionRef).toBe(connectionRef);
    expect(plan.actions).toEqual([
      "Updated config version from 2 to 3.",
      "Added OAuth connection for profile 'production' and upstream 'default'."
    ]);
    expect(plan.config).toMatchObject({
      version: "3",
      description: "preserve me",
      oauth: {
        connections: {
          [connectionRef]: {
            profile: "production",
            upstream: "default",
            resource: "https://mcp.example.test/mcp",
            issuer: "https://auth.example.test",
            clientRegistration: "dynamic",
            scopes: ["openid", "profile"]
          }
        }
      }
    });
  });

  it("rejects ambiguous or incompatible targets through stable typed configuration diagnostics", () => {
    const named = {
      ...versionTwoConfig(),
      upstream: undefined,
      upstreams: {
        first: { transport: "streamable-http", url: "https://first.example.test/mcp" },
        second: { transport: "streamable-http", url: "https://second.example.test/mcp" }
      }
    };

    expect(() => planOAuthConnectionAdd(named, { ...request, upstream: undefined }, connectionRef)).toThrowError(
      expect.objectContaining({ code: "OAUTH_CONNECTION_TARGET_REQUIRED" })
    );
    expect(() =>
      planOAuthConnectionAdd(
        {
          ...versionTwoConfig(),
          upstream: {
            transport: "streamable-http",
            url: "https://mcp.example.test/mcp",
            headers: { Authorization: "secretref:env://TOKEN" }
          }
        },
        request,
        connectionRef
      )
    ).toThrowError(expect.objectContaining({ code: "CONFIG_SCHEMA_INVALID" }));

    const existing = planOAuthConnectionAdd(versionTwoConfig(), request, connectionRef).config;
    expect(() => planOAuthConnectionAdd(existing, request, connectionRef)).toThrowError(
      expect.objectContaining({ code: "OAUTH_CONNECTION_INVALID" })
    );
  });

  it("keeps dry runs reviewable and writes only after explicit opt-in with a unique backup and audit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-connection-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(versionTwoConfig(), null, 2)}\n`;
    await writeFile(configPath, original, "utf8");
    const audit = new MemoryAuditSink();

    const preview = await runConnectionAddCommand(
      { configPath, ...request, connectionRef, write: false },
      { audit }
    );

    expect(preview).toMatchObject({ changed: true, write: false, connectionRef });
    expect(preview).not.toHaveProperty("backupPath");
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(audit.events).toEqual([]);

    const applied = await runConnectionAddCommand(
      { configPath, ...request, connectionRef, write: true },
      { audit }
    );

    expect(applied.write).toBe(true);
    expect(applied.backupPath).toEqual(expect.stringContaining("miftah.json.miftah-backup-"));
    expect(await readFile(applied.backupPath!, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      version: "3",
      oauth: { connections: { [connectionRef]: { profile: "production" } } }
    });
    expect(audit.prepared).toBe(true);
    expect(audit.events).toEqual([
      {
        action: "add",
        profile: "production",
        upstream: "default",
        status: "success"
      }
    ]);
    await expect(access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes the configured fail-closed audit journal without connection metadata or credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-connection-audit-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const auditPath = join(directory, "audit.jsonl");
    await writeFile(
      configPath,
      `${JSON.stringify({ ...versionTwoConfig(), audit: { enabled: true, path: auditPath } }, null, 2)}\n`,
      "utf8"
    );

    await runConnectionAddCommand({ configPath, ...request, connectionRef, write: true });

    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain('"operation":"config/oauth-connection-add"');
    expect(audit).toContain('"profile":"production"');
    expect(audit).not.toContain(connectionRef);
    expect(audit).not.toContain("https://auth.example.test");
    expect(audit).not.toContain("token");
  });
});
