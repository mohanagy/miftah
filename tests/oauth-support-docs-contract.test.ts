import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function repositoryFile(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("OAuth support documentation contract", () => {
  it("publishes the current OAuth boundary, provider matrix, and safe fallback", async () => {
    const [oauthSupport, readme, config, security, architecture, libraryApi] = await Promise.all([
      repositoryFile("docs/oauth-support.md"),
      repositoryFile("README.md"),
      repositoryFile("docs/config.md"),
      repositoryFile("docs/security.md"),
      repositoryFile("docs/architecture.md"),
      repositoryFile("docs/library-api.md")
    ]);

    expect(readme).toContain("[OAuth support](docs/oauth-support.md)");
    expect(config).toContain("[OAuth support](oauth-support.md)");
    expect(security).toContain("[OAuth support](oauth-support.md)");
    expect(architecture).toContain("[OAuth support](oauth-support.md)");
    expect(libraryApi).toContain("[OAuth support](oauth-support.md)");

    expect(oauthSupport).toContain("# OAuth support and compatibility");
    expect(oauthSupport).toContain(
      "Miftah does not currently perform OAuth discovery, client registration, browser authorization, callbacks, token refresh, or revocation."
    );
    expect(oauthSupport).toContain("Miftah does not support OAuth for every MCP server or provider.");
    expect(oauthSupport).toContain("| Support class | Transport and current ownership | Operator fallback |");

    for (const supportClass of [
      "Standards-compatible remote HTTP MCP OAuth",
      "Provider-adapter-backed local or non-standard OAuth",
      "Upstream-owned or manual credentials",
      "Unsupported authentication patterns"
    ]) {
      expect(oauthSupport).toContain(supportClass);
    }

    for (const lifecycleStep of [
      "discovery",
      "client registration",
      "authorization",
      "callback",
      "refresh",
      "reauth",
      "revoke",
      "identity evidence"
    ]) {
      expect(oauthSupport).toContain(lifecycleStep);
    }

    expect(oauthSupport).toContain("Google Search Console-style local OAuth");
    expect(oauthSupport).toContain("Miftah must not scrape, copy, or manage that upstream token cache.");
    expect(oauthSupport).toContain(
      "Miftah does not own, parse, scrape, import, replay, or lifecycle-manage provider passwords, browser cookies, or arbitrary third-party token caches as OAuth artifacts."
    );
    expect(oauthSupport).not.toContain("Miftah does not accept provider passwords");
    expect(security).toContain(
      "it does not own, parse, scrape, import, replay, or lifecycle-manage provider passwords, browser cookies, or arbitrary third-party token caches as OAuth artifacts."
    );
    expect(oauthSupport).toContain(
      "Complete the provider-owned login, supply its documented credential path, environment value, or static secret reference, then run `miftah validate` and `miftah doctor`."
    );
    expect(oauthSupport).toContain("`not-verified`");
    expect(oauthSupport).toContain("`verified`");
    expect(oauthSupport).toContain("`expired`");
    expect(oauthSupport).toContain("`unsupported`");
    expect(oauthSupport).toContain("OAuth success, token validity, and granted scopes are not account authorization.");
  });

  it("keeps the public boundary aligned with the current configuration and runtime", async () => {
    const [oauthSupport, configTypes, schema, libraryIndex, upstreamManager] = await Promise.all([
      repositoryFile("docs/oauth-support.md"),
      repositoryFile("src/config/types.ts"),
      repositoryFile("src/config/schema.ts"),
      repositoryFile("src/index.ts"),
      repositoryFile("src/upstream/upstream-process-manager.ts")
    ]);

    expect(configTypes).toContain('headers?: Record<string, string>;');
    expect(schema).toContain("headers: z.record(z.string(), z.string()).optional()");
    expect(schema).toContain(".strict()");
    expect(schema).not.toContain("oauth:");
    expect(libraryIndex).not.toContain("OAuth");
    expect(upstreamManager).toContain("requestInit: { headers }");
    expect(upstreamManager).not.toContain("authProvider");

    expect(oauthSupport).toContain("There is no `oauth` configuration object, OAuth public type/export, or adapter API in this release.");
    expect(oauthSupport).toContain("Remote transports use configured static `headers` only; they do not pass an OAuth client provider to the MCP SDK.");
    expect(oauthSupport).toContain("Any future OAuth surface must be additive, versioned, and paired with an explicit migration and release note.");
  });
});
