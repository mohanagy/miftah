import { describe, expect, it } from "vitest";
import {
  getProviderAdapterForProfileTarget,
  PROVIDER_ADAPTER_CATALOG
} from "../src/config/provider-adapters.js";
import type {
  ProviderAdapterDefinition,
  ProviderAdapterOperation,
  ProviderAuthenticationContract
} from "../src/config/provider-adapters.js";
import type { MiftahConfig } from "../src/config/types.js";

// @ts-expect-error Upstream-owned credentials cannot claim Miftah's browser or vault.
const invalidMixedOwnership: ProviderAuthenticationContract = {
  credentialOwnership: "upstream",
  browserHandoff: "miftah",
  tokenStore: "miftah-vault"
};
void invalidMixedOwnership;

// @ts-expect-error MCP-tool operations must name the upstream tool to invoke.
const invalidUnnamedMcpTool: ProviderAdapterOperation = {
  owner: "upstream",
  mechanism: "mcp-tool"
};
void invalidUnnamedMcpTool;

// @ts-expect-error Unavailable identity evidence cannot claim verified assurance.
const invalidIdentityAssurance: ProviderAdapterDefinition["identity"] = {
  evidence: "unavailable",
  assurance: "verified"
};
void invalidIdentityAssurance;

function gscConfig(): MiftahConfig {
  return {
    version: "3",
    name: "gsc",
    defaultProfile: "work",
    upstream: {
      transport: "stdio",
      command: "uvx",
      args: ["mcp-search-console@0.3.2"]
    },
    profiles: { work: {} }
  };
}

function namedGscConfig(): MiftahConfig {
  return {
    version: "3",
    name: "gsc",
    defaultProfile: "work",
    upstreams: {
      analytics: {
        transport: "stdio",
        command: "uvx",
        args: ["mcp-search-console@0.3.2"]
      }
    },
    profiles: { work: { upstreams: { analytics: {} } } }
  };
}

describe("provider adapter contract", () => {
  it("describes the GSC pilot as upstream-owned without claiming native OAuth or identity proof", () => {
    const adapter = PROVIDER_ADAPTER_CATALOG.adapters["google-search-console"];

    expect(PROVIDER_ADAPTER_CATALOG.version).toBe("1");
    expect(adapter.preset).toBe("google-search-console");
    expect(adapter.launch).toEqual({
      transport: "stdio",
      command: "uvx",
      args: ["mcp-search-console@0.3.2"],
      prerequisites: ["Python >=3.11", "uv/uvx", "Google OAuth desktop client-secrets JSON"]
    });
    expect(adapter.execution).toEqual({
      allowedEnvironment: [
        "GSC_OAUTH_CLIENT_SECRETS_FILE",
        "GSC_CONFIG_DIR",
        "GSC_CREDENTIALS_PATH",
        "GSC_SKIP_OAUTH"
      ],
      cwd: "inherit",
      isolation: "none"
    });
    expect(adapter.authentication).toEqual({
      credentialOwnership: "upstream",
      browserHandoff: "upstream",
      tokenStore: "upstream-private"
    });
    expect(adapter.lifecycle).toEqual({
      health: { owner: "upstream", mechanism: "mcp-tool", name: "get_capabilities" },
      reauth: { owner: "upstream", mechanism: "mcp-tool", name: "reauthenticate" },
      disconnect: { owner: "manual-only", mechanism: "provider-console" }
    });
    expect(adapter.identity).toEqual({ evidence: "unavailable", assurance: "none" });
    expect(adapter.diagnostics).toEqual({
      mode: "metadata-only",
      tokenCacheAccess: "forbidden",
      safeReadProbe: { name: "get_capabilities", input: "empty-object" },
      safeHealthTool: "get_capabilities"
    });
    expect(adapter.destructiveTools).toEqual({
      default: "disabled",
      enablement: "manual-only",
      upstreamEnvironmentControl: "GSC_ALLOW_DESTRUCTIVE"
    });
    expect(adapter.manualSetup.supported).toBe(true);
  });

  it("trusts the GSC adapter only inside its declared execution envelope", () => {
    const generated = gscConfig();
    generated.profiles.work!.env = {
      GSC_OAUTH_CLIENT_SECRETS_FILE: "/private/client-secrets.json",
      GSC_CONFIG_DIR: "/private/cache"
    };
    expect(getProviderAdapterForProfileTarget(generated, "work", "default")).toBeDefined();

    const serviceAccount = gscConfig();
    serviceAccount.profiles.work!.env = {
      GSC_CREDENTIALS_PATH: "/private/service-account.json",
      GSC_SKIP_OAUTH: "true"
    };
    expect(getProviderAdapterForProfileTarget(serviceAccount, "work", "default")).toBeDefined();

    const named = namedGscConfig();
    named.profiles.work!.upstreams!.analytics!.env = { GSC_CONFIG_DIR: "/private/named-cache" };
    expect(getProviderAdapterForProfileTarget(named, "work", "analytics")).toBeDefined();
  });

  it("uses the effective profile arguments rather than rejecting a harmless base argument default", () => {
    const rootOverride = gscConfig();
    rootOverride.upstream!.args = ["mcp-search-console@0.3.1"];
    rootOverride.profiles.work!.args = ["mcp-search-console@0.3.2"];
    expect(getProviderAdapterForProfileTarget(rootOverride, "work", "default")).toBeDefined();

    const namedOverride = namedGscConfig();
    namedOverride.upstreams!.analytics!.args = ["mcp-search-console@0.3.1"];
    namedOverride.profiles.work!.upstreams!.analytics!.args = ["mcp-search-console@0.3.2"];
    expect(getProviderAdapterForProfileTarget(namedOverride, "work", "analytics")).toBeDefined();
  });

  it("does not trust a named-upstream override that a singleton runtime will never execute", () => {
    const singleton = gscConfig();
    singleton.profiles.work!.args = ["unreviewed-singleton-argument"];
    singleton.profiles.work!.upstreams = {
      default: { args: ["mcp-search-console@0.3.2"] }
    };

    expect(getProviderAdapterForProfileTarget(singleton, "work", "default")).toBeUndefined();
  });

  it("fails closed when configuration can change the adapter launch environment", () => {
    const unsafeEnvironment: readonly (readonly [string, string])[] = [
      ["PATH", "/untrusted/bin"],
      ["Path", "C:\\untrusted\\bin"],
      ["PATHEXT", ".CMD"],
      ["UV_INDEX_URL", "https://untrusted.example.test/simple"],
      ["PYTHONPATH", "/untrusted/python"],
      ["NODE_OPTIONS", "--require /untrusted/hook.cjs"],
      ["GSC_ALLOW_DESTRUCTIVE", "true"],
      ["ARBITRARY_PROVIDER_OPTION", "untrusted"]
    ];
    for (const [key, value] of unsafeEnvironment) {
      const profile = gscConfig();
      profile.profiles.work!.env = { [key]: value };
      expect(getProviderAdapterForProfileTarget(profile, "work", "default"), key).toBeUndefined();

      const upstream = gscConfig();
      upstream.upstream!.env = { [key]: value };
      expect(getProviderAdapterForProfileTarget(upstream, "work", "default"), key).toBeUndefined();

      const named = namedGscConfig();
      named.profiles.work!.upstreams!.analytics!.env = { [key]: value };
      expect(getProviderAdapterForProfileTarget(named, "work", "analytics"), key).toBeUndefined();
    }
  });

  it("fails closed when configuration changes the working directory or isolation boundary", () => {
    const upstreamCwd = gscConfig();
    upstreamCwd.upstream!.cwd = "/untrusted";
    expect(getProviderAdapterForProfileTarget(upstreamCwd, "work", "default")).toBeUndefined();

    const profileCwd = gscConfig();
    profileCwd.profiles.work!.cwd = "/untrusted";
    expect(getProviderAdapterForProfileTarget(profileCwd, "work", "default")).toBeUndefined();

    const namedCwd = namedGscConfig();
    namedCwd.profiles.work!.upstreams!.analytics!.cwd = "/untrusted";
    expect(getProviderAdapterForProfileTarget(namedCwd, "work", "analytics")).toBeUndefined();

    const profileIsolation = gscConfig();
    profileIsolation.profiles.work!.isolation = { files: [] };
    expect(getProviderAdapterForProfileTarget(profileIsolation, "work", "default")).toBeUndefined();

    const namedIsolation = namedGscConfig();
    namedIsolation.profiles.work!.upstreams!.analytics!.isolation = { files: [] };
    expect(getProviderAdapterForProfileTarget(namedIsolation, "work", "analytics")).toBeUndefined();
  });
});
