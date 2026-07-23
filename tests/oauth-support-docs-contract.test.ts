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
    expect(oauthSupport).toContain("Version 3 enables a deliberately narrow standards-compatible remote OAuth flow");
    expect(oauthSupport).not.toContain("OAUTH_AUTHORIZATION_NOT_ENABLED");
    expect(oauthSupport).toContain(
      "Miftah performs protected-resource and authorization-server discovery, browser authorization, a literal-loopback callback, authorization-code exchange, refresh, and bearer injection only for an exact configured HTTPS Streamable HTTP connection."
    );
    expect(oauthSupport).toContain("Miftah does not support OAuth for every MCP server or provider.");
    expect(oauthSupport).toContain("`pre-registered:<client-id>`");
    expect(oauthSupport).toContain("`client-id-metadata:<https-url>`");
    expect(oauthSupport).toContain("`dynamic`");
    expect(oauthSupport).toContain("Credentials are stored only through the platform OS vault adapter");
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
    expect(configTypes).toContain("export interface OAuthConfig");
    expect(configTypes).toContain("export interface OAuthConnectionConfig");
    expect(schema).toContain("oauth: oauthConfigSchema.optional()");
    expect(libraryIndex).toContain("OAuthConfig");
    expect(libraryIndex).toContain("OAuthConnectionConfig");
    expect(libraryIndex).toContain("OAuthConnectionRef");
    expect(upstreamManager).toMatch(/requestInit:\s*\{\s*headers\s*\}/u);
    expect(upstreamManager).toContain("authProvider: oauthProvider");

    expect(oauthSupport).toContain("Version 3 adds `oauth.connections`");
    expect(oauthSupport).toContain("Static `Authorization` headers on that exact profile/upstream are rejected");
    expect(oauthSupport).toContain("The exact OAuth-bound Streamable HTTP transport receives the profile-bound OAuth client provider.");
    expect(oauthSupport).toContain("`auth disconnect` does not claim provider-side token revocation");
    expect(oauthSupport).toContain("miftah auth reauth");
    expect(oauthSupport).toContain("OAUTH_INTERACTIVE_REQUIRED");
  });
});
