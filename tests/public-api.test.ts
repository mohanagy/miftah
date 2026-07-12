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
  IdentityConfig,
  IdentityFingerprint,
  IdentityProbeConfig,
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
  "IdentityConfig",
  "IdentityFingerprint",
  "IdentityProbeConfig",
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
  IdentityConfig,
  IdentityFingerprint,
  IdentityProbeConfig,
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

const validTextIdentityConfig: IdentityConfig = {
  expected: { provider: "github", login: "mona" },
  probe: { tool: "whoami", resultFormat: "text", provider: "github" },
  maxAgeMs: 60_000,
  requiredForRisk: ["write"]
};

const validDestructiveIdentityConfig: IdentityConfig = {
  expected: { provider: "github", login: "mona" },
  probe: { tool: "whoami", resultFormat: "text", provider: "github" },
  maxAgeMs: 60_000,
  requiredForRisk: ["destructive"]
};

const validWriteThenDestructiveIdentityConfig: IdentityConfig = {
  expected: { provider: "github", login: "mona" },
  probe: { tool: "whoami", resultFormat: "text", provider: "github" },
  maxAgeMs: 60_000,
  requiredForRisk: ["write", "destructive"]
};

const validDestructiveThenWriteIdentityConfig: IdentityConfig = {
  expected: { provider: "github", login: "mona" },
  probe: { tool: "whoami", resultFormat: "text", provider: "github" },
  maxAgeMs: 60_000,
  requiredForRisk: ["destructive", "write"]
};

const invalidDuplicateRiskIdentityConfig: IdentityConfig = {
  expected: { provider: "github", login: "mona" },
  probe: { tool: "whoami", resultFormat: "text", provider: "github" },
  maxAgeMs: 60_000,
  // @ts-expect-error Identity risk requirements must be unique.
  requiredForRisk: ["write", "write"]
};

const validJsonIdentityConfig: IdentityConfig = {
  expected: { organization: "lubab" },
  probe: { tool: "identity", resultFormat: "json" },
  maxAgeMs: 60_000
};

const validTextIdentityProbe: IdentityProbeConfig = {
  tool: "whoami",
  resultFormat: "text",
  provider: "github"
};

const validJsonIdentityProbe: IdentityProbeConfig = {
  tool: "identity",
  resultFormat: "json"
};

// @ts-expect-error Text probes require an expected login.
const invalidTextIdentityWithoutLogin: IdentityConfig = {
  expected: { provider: "github" },
  probe: { tool: "whoami", resultFormat: "text", provider: "github" },
  maxAgeMs: 60_000
};

// @ts-expect-error Text probes cannot verify an organization.
const invalidTextIdentityOrganization: IdentityConfig = {
  expected: { login: "mona", organization: "lubab" },
  probe: { tool: "whoami", resultFormat: "text" },
  maxAgeMs: 60_000
};

// @ts-expect-error Expected text providers require a static probe provider.
const invalidTextIdentityProviderWithoutProbeProvider: IdentityConfig = {
  expected: { provider: "github", login: "mona" },
  probe: { tool: "whoami", resultFormat: "text" },
  maxAgeMs: 60_000
};

const invalidJsonIdentityStaticProvider: IdentityConfig = {
  expected: { login: "mona" },
  // @ts-expect-error JSON probes derive their provider from the response.
  probe: { tool: "identity", resultFormat: "json", provider: "github" },
  maxAgeMs: 60_000
};

const invalidJsonIdentityEmptyExpected: IdentityConfig = {
  // @ts-expect-error JSON probes require at least one expected fingerprint field.
  expected: {},
  probe: { tool: "identity", resultFormat: "json" },
  maxAgeMs: 60_000
};

// @ts-expect-error JSON probes do not support a static provider.
const invalidJsonIdentityProbe: IdentityProbeConfig = {
  tool: "identity",
  resultFormat: "json",
  provider: "github"
};

void [
  validTextIdentityConfig,
  validDestructiveIdentityConfig,
  validWriteThenDestructiveIdentityConfig,
  validDestructiveThenWriteIdentityConfig,
  invalidDuplicateRiskIdentityConfig,
  validJsonIdentityConfig,
  validTextIdentityProbe,
  validJsonIdentityProbe,
  invalidTextIdentityWithoutLogin,
  invalidTextIdentityOrganization,
  invalidTextIdentityProviderWithoutProbeProvider,
  invalidJsonIdentityStaticProvider,
  invalidJsonIdentityEmptyExpected,
  invalidJsonIdentityProbe
];

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
    expect(documentation).toContain(
      "For text probes, `validateConfig` runtime-validates equality between `expected.provider` and a static `probe.provider`; JSON probes do not permit a static provider."
    );
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
