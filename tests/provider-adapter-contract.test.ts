import { describe, expect, it } from "vitest";
import { PROVIDER_ADAPTER_CATALOG } from "../src/config/provider-adapters.js";
import type {
  ProviderAdapterDefinition,
  ProviderAdapterOperation,
  ProviderAuthenticationContract
} from "../src/config/provider-adapters.js";

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
      safeHealthTool: "get_capabilities"
    });
    expect(adapter.destructiveTools).toEqual({
      default: "disabled",
      enablement: "manual-only",
      upstreamEnvironmentControl: "GSC_ALLOW_DESTRUCTIVE"
    });
    expect(adapter.manualSetup.supported).toBe(true);
  });
});
