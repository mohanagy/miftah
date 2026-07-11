import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as api from "../src/index.js";
import type {
  AuditConfig,
  ConfigDiagnostic,
  MiftahConfig,
  MiftahErrorCode,
  MiftahErrorDetails,
  MiftahRuntime,
  PolicyConfig,
  ProcessConfig,
  ProfileConfig,
  ProfileUpstreamOverride,
  RiskLevel,
  RoutingConfig,
  RoutingRule,
  SecurityConfig,
  ToolDiscoveryMode,
  ToolingConfig,
  TransportType,
  UpstreamConfig,
  ValidatedRoutingConfig
} from "../src/index.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-upstream.mjs");

const supportedRuntimeExports = [
  "MIFTAH_VERSION",
  "MiftahError",
  "createMiftahRuntime",
  "generateConfigSchema",
  "loadConfig",
  "presetConfig",
  "validateConfig"
] as const;

const internalRuntimeExports = [
  "AuditLogger",
  "MiftahServer",
  "PolicyEngine",
  "ProfileManager",
  "RoutingEngine",
  "SecretResolver",
  "UpstreamProcessManager",
  "UpstreamSession",
  "createRedactor",
  "redactSecrets"
] as const;

const supportedTypeExports = [
  "AuditConfig",
  "ConfigDiagnostic",
  "MiftahConfig",
  "MiftahErrorCode",
  "MiftahErrorDetails",
  "MiftahRuntime",
  "PolicyConfig",
  "ProcessConfig",
  "ProfileConfig",
  "ProfileUpstreamOverride",
  "RiskLevel",
  "RoutingConfig",
  "RoutingRule",
  "SecurityConfig",
  "ToolDiscoveryMode",
  "ToolingConfig",
  "TransportType",
  "UpstreamConfig",
  "ValidatedRoutingConfig"
] as const;

type PublicTypeImportCoverage = [
  AuditConfig,
  ConfigDiagnostic,
  MiftahConfig,
  MiftahErrorCode,
  MiftahErrorDetails,
  MiftahRuntime,
  PolicyConfig,
  ProcessConfig,
  ProfileConfig,
  ProfileUpstreamOverride,
  RiskLevel,
  RoutingConfig,
  RoutingRule,
  SecurityConfig,
  ToolDiscoveryMode,
  ToolingConfig,
  TransportType,
  UpstreamConfig,
  ValidatedRoutingConfig
];

void (undefined as unknown as PublicTypeImportCoverage);

describe("public library API", () => {
  it("exposes only the intentionally supported runtime API", () => {
    expect(Object.keys(api).sort()).toEqual([...supportedRuntimeExports].sort());
    for (const name of supportedRuntimeExports) {
      expect(api).toHaveProperty(name);
    }
  });

  it("keeps internal runtime wiring out of the package root", () => {
    for (const name of internalRuntimeExports) {
      expect(api).not.toHaveProperty(name);
    }
  });

  it("documents every supported runtime and type export", () => {
    const documentation = readFileSync(new URL("../docs/library-api.md", import.meta.url), "utf8");

    for (const name of [...supportedRuntimeExports, ...supportedTypeExports]) {
      expect(documentation).toContain(`\`${name}\``);
    }
  });

  it("uses the package version for wrapper and upstream MCP metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-public-api-"));
    const configPath = join(directory, "miftah.json");
    const clientInfoPath = join(directory, "upstream-client-info.json");
    const config = {
      version: "1",
      name: "public-api",
      defaultProfile: "work",
      upstream: {
        transport: "stdio",
        command: process.execPath,
        args: [fixture]
      },
      profiles: {
        work: {
          env: {
            TEST_CLIENT_INFO_PATH: clientInfoPath
          }
        }
      }
    };
    await writeFile(configPath, JSON.stringify(config));

    const runtime = await api.createMiftahRuntime(configPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "public-api-test", version: "1.0.0" });
    try {
      expect(runtime).not.toHaveProperty("manager");
      expect(runtime).not.toHaveProperty("server");
      await Promise.all([runtime.connect(serverTransport), client.connect(clientTransport)]);
      expect(client.getServerVersion()).toMatchObject({
        name: "miftah-public-api",
        version: api.MIFTAH_VERSION
      });

      await client.listTools();
      expect(JSON.parse(await readFile(clientInfoPath, "utf8"))).toMatchObject({
        name: "miftah",
        version: api.MIFTAH_VERSION
      });
    } finally {
      await client.close();
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
