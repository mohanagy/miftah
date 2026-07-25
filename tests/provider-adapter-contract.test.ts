import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  buildProviderAdapterAccountProfile,
  getProviderAdapterForAccountProvisioning,
  getProviderAdapterForProfileTarget,
  PROVIDER_ADAPTER_CATALOG,
  ProviderAdapterAccountProfileError
} from "../src/config/provider-adapters.js";
import type {
  ProviderAdapterDefinition,
  ProviderAdapterOperation,
  ProviderAuthenticationContract
} from "../src/config/provider-adapters.js";
import type { MiftahConfig } from "../src/config/types.js";

function privatePath(...segments: readonly string[]): string {
  return resolve("/private", ...segments);
}

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
    expect(adapter.accountProvisioning).toEqual({
      credentialFile: {
        environment: "GSC_OAUTH_CLIENT_SECRETS_FILE",
        label: "Google OAuth client-secrets file",
        placeholder: "/Users/you/gsc-client-secrets.json"
      },
      stateDirectory: {
        environment: "GSC_CONFIG_DIR",
        namespace: "gsc-oauth"
      },
      defaultProfile: {
        description: "Google Search Console account (OAuth owned by upstream)",
        policy: "readonly"
      }
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

  it("allows provider-account addition only when every existing account has literal isolated provider state", () => {
    const safe = gscConfig();
    safe.profiles.work!.env = {
      GSC_OAUTH_CLIENT_SECRETS_FILE: privatePath("work-client-secrets.json"),
      GSC_CONFIG_DIR: privatePath("miftah", "gsc", "work")
    };
    safe.profiles.personal = {
      env: {
        GSC_OAUTH_CLIENT_SECRETS_FILE: privatePath("personal-client-secrets.json"),
        GSC_CONFIG_DIR: privatePath("miftah", "gsc", "personal")
      }
    };
    expect(getProviderAdapterForAccountProvisioning(safe)).toBeDefined();

    const relativeCredential = structuredClone(safe);
    relativeCredential.profiles.work!.env!.GSC_OAUTH_CLIENT_SECRETS_FILE = "client-secrets.json";
    expect(getProviderAdapterForAccountProvisioning(relativeCredential)).toBeUndefined();

    const interpolatedCredential = structuredClone(safe);
    interpolatedCredential.profiles.work!.env!.GSC_OAUTH_CLIENT_SECRETS_FILE = "${HOME}/client-secrets.json";
    expect(getProviderAdapterForAccountProvisioning(interpolatedCredential)).toBeUndefined();

    const relativeStateDirectory = structuredClone(safe);
    relativeStateDirectory.profiles.work!.env!.GSC_CONFIG_DIR = ".miftah/gsc/work";
    expect(getProviderAdapterForAccountProvisioning(relativeStateDirectory)).toBeUndefined();

    const sharedStateDirectory = structuredClone(safe);
    sharedStateDirectory.profiles.personal!.env!.GSC_CONFIG_DIR = privatePath("miftah", "gsc", "work");
    expect(getProviderAdapterForAccountProvisioning(sharedStateDirectory)).toBeUndefined();

    const caseVariantStateDirectory = structuredClone(safe);
    caseVariantStateDirectory.profiles.personal!.env!.GSC_CONFIG_DIR = privatePath("miftah", "gsc", "WORK");
    expect(getProviderAdapterForAccountProvisioning(caseVariantStateDirectory)).toBeUndefined();

    const trailingWindowsAlias = structuredClone(safe);
    trailingWindowsAlias.profiles.personal!.env!.GSC_CONFIG_DIR = privatePath("miftah", "gsc", "work. ");
    expect(getProviderAdapterForAccountProvisioning(trailingWindowsAlias)).toBeUndefined();
  });

  it("fails closed when a named upstream can override an otherwise isolated account binding", () => {
    const safe: MiftahConfig = {
      version: "3",
      name: "gsc",
      defaultProfile: "work",
      upstreams: {
        primary: {
          transport: "stdio",
          command: "uvx",
          args: ["mcp-search-console@0.3.2"]
        },
        secondary: {
          transport: "stdio",
          command: "uvx",
          args: ["mcp-search-console@0.3.2"]
        }
      },
      profiles: {
        work: {
          env: {
            GSC_OAUTH_CLIENT_SECRETS_FILE: privatePath("work-client-secrets.json"),
            GSC_CONFIG_DIR: privatePath("miftah", "gsc", "work")
          },
          upstreams: { primary: {}, secondary: {} }
        },
        personal: {
          env: {
            GSC_OAUTH_CLIENT_SECRETS_FILE: privatePath("personal-client-secrets.json"),
            GSC_CONFIG_DIR: privatePath("miftah", "gsc", "personal")
          },
          upstreams: { primary: {}, secondary: {} }
        }
      }
    };

    for (const [environment, value] of [
      ["GSC_CONFIG_DIR", privatePath("miftah", "gsc", "shared")],
      ["GSC_OAUTH_CLIENT_SECRETS_FILE", privatePath("other-client-secrets.json")]
    ] as const) {
      const overridden = structuredClone(safe);
      overridden.profiles.work!.upstreams!.secondary!.env = { [environment]: value };

      // The upstream target is still a reviewed launch shape, but the account
      // provisioning flow must not infer isolation from the base profile alone.
      expect(getProviderAdapterForProfileTarget(overridden, "work", "secondary")).toBeDefined();
      expect(getProviderAdapterForAccountProvisioning(overridden), environment).toBeUndefined();
    }
  });

  it("keeps provider-owned state inside its adapter namespace for every direct account-profile caller", () => {
    const adapter = PROVIDER_ADAPTER_CATALOG.adapters["google-search-console"];
    const request = {
      configurationName: "gsc",
      configurationPath: privatePath("miftah", "gsc.json"),
      credentialFile: privatePath("client-secrets.json")
    };

    for (const profile of [
      ".",
      "..",
      "../outside",
      "nested/account",
      "nested\\account",
      "google\0work",
      "__proto__",
      "constructor",
      "prototype"
    ]) {
      expect(() => buildProviderAdapterAccountProfile(adapter, { ...request, profile })).toThrow(ProviderAdapterAccountProfileError);
    }
  });

  it("uses one canonical provider-state directory for case-variant account names", () => {
    const adapter = PROVIDER_ADAPTER_CATALOG.adapters["google-search-console"];
    const request = {
      configurationName: "gsc",
      configurationPath: privatePath("miftah", "gsc.json"),
      credentialFile: privatePath("client-secrets.json")
    };

    const lowercase = buildProviderAdapterAccountProfile(adapter, { ...request, profile: "google-work" });
    const uppercase = buildProviderAdapterAccountProfile(adapter, { ...request, profile: "Google-Work" });

    expect(uppercase.env?.GSC_CONFIG_DIR).toBe(lowercase.env?.GSC_CONFIG_DIR);
  });

  it("reports the direct account-profile validation cause without misdescribing it as a credential path", () => {
    const adapter = PROVIDER_ADAPTER_CATALOG.adapters["google-search-console"];
    const request = {
      configurationName: "gsc",
      configurationPath: privatePath("miftah", "gsc.json"),
      profile: "google-work",
      credentialFile: privatePath("client-secrets.json")
    };
    const unsupported: ProviderAdapterDefinition = { ...adapter, accountProvisioning: undefined };

    expect(() => buildProviderAdapterAccountProfile(adapter, {
      ...request,
      credentialFile: "client-secrets.json"
    })).toThrow("requires an absolute literal credential-file path");
    expect(() => buildProviderAdapterAccountProfile(adapter, { ...request, profile: "../outside" }))
      .toThrow("requires a safe profile name");
    expect(() => buildProviderAdapterAccountProfile(unsupported, request))
      .toThrow("does not support adding provider-owned accounts");
  });
});
