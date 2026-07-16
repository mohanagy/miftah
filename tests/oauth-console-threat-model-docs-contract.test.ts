import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function document(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("OAuth and Console threat-model documentation contract", () => {
  it("publishes the future security delta without implying that OAuth or a Console exists today", async () => {
    const [delta, threatModel, oauthSupport, security, architecture, readme] = await Promise.all([
      document("docs/oauth-console-threat-model.md"),
      document("docs/threat-model.md"),
      document("docs/oauth-support.md"),
      document("docs/security.md"),
      document("docs/architecture.md"),
      document("README.md")
    ]);

    expect(threatModel).toContain("[OAuth and local Console design delta](oauth-console-threat-model.md)");
    expect(oauthSupport).toContain("[OAuth and local Console design delta](oauth-console-threat-model.md)");
    expect(security).toContain("[OAuth and Console security design delta](oauth-console-threat-model.md)");
    expect(architecture).toContain("[OAuth and Console security design delta](oauth-console-threat-model.md)");
    expect(readme).toContain("[OAuth and Console security design](docs/oauth-console-threat-model.md)");

    expect(delta).toContain("# OAuth broker and local Console design delta");
    expect(delta).toContain("No production OAuth broker, Console, callback listener, or token store exists in this release.");
    expect(delta).toContain("The future Console control API is distinct from the MCP /mcp endpoint.");
    expect(delta).toContain("OAuth access tokens and refresh tokens must not appear in configuration, audit events, diagnostics, logs, query strings, browser storage, or Console UI responses.");
    expect(delta).toContain("An authorization code can arrive only at the bounded callback and must be exchanged without being persisted, logged, audited, or rendered.");
  });

  it("defines protocol go/no-go, abuse cases, residual risks, and a pre-implementation security test plan", async () => {
    const delta = await document("docs/oauth-console-threat-model.md");

    expect(delta).toContain("## Protocol go/no-go decision");
    expect(delta).toContain("GO: standards-compatible HTTPS Streamable HTTP MCP");
    expect(delta).toContain("NO-GO: provider-specific, undocumented, or opaque OAuth conventions");
    expect(delta).toContain("PKCE S256");
    expect(delta).toContain("issuer and resource binding");
    expect(delta).toContain("exact redirect validation");

    for (const threat of [
      "**Redirect mix-up or issuer substitution**",
      "**Authorization-code or token replay**",
      "**Cross-profile or cross-resource credential leakage**",
      "**Browser CSRF or hostile local origin**",
      "**Local network exposure and same-user control**",
      "**Broker or IPC confusion**"
    ]) {
      expect(delta).toContain(threat);
    }

    expect(delta).toContain("## Focused security test plan before implementation");
    for (const testArea of [
      "metadata discovery",
      "PKCE verifier",
      "state",
      "redirect",
      "replay",
      "cross-profile",
      "CSRF",
      "Host and Origin",
      "request and session limits",
      "redaction"
    ]) {
      expect(delta).toContain(testArea);
    }
  });

  it("fails closed on issuer provenance, unsupported MCP metadata, Console bootstrap, and static bearer collisions", async () => {
    const delta = await document("docs/oauth-console-threat-model.md");

    expect(delta).toContain("RFC 9207 `iss`");
    expect(delta).toContain("exactly one `iss`");
    expect(delta).toContain("A callback without that `iss` is a no-go");
    expect(delta).toContain("valid `state` accompanies a code from another issuer");

    expect(delta).toContain("`WWW-Authenticate` `resource_metadata`");
    expect(delta).toContain("OAuth Authorization Server Metadata and OpenID Connect Discovery");
    expect(delta).toContain("`code_challenge_methods_supported` includes `S256`");
    expect(delta).toContain("`client_id_metadata_document_supported` is `true`");
    expect(delta).toContain("`registration_endpoint` is advertised");
    expect(delta).toContain("Client registration must prefer a pre-registered client.");
    expect(delta).toContain("A verified Client ID Metadata Document is allowed only when `client_id_metadata_document_supported` is `true`");

    expect(delta).toContain("Console implementation is NO-GO until its initial browser bootstrap has a separately approved security design");
    expect(delta).toContain("A profile cannot enable native OAuth while the same upstream has a static `Authorization` header");
    expect(delta).toContain("explicitly remove or migrate that header");
  });
});
