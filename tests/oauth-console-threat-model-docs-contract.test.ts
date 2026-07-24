import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function document(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("OAuth and Console threat-model documentation contract", () => {
  it("publishes implemented remote OAuth and the separate Console control boundary without overstating either", async () => {
    const [delta, threatModel, oauthSupport, security, architecture, consoleApi, readme] = await Promise.all([
      document("docs/oauth-console-threat-model.md"),
      document("docs/threat-model.md"),
      document("docs/oauth-support.md"),
      document("docs/security.md"),
      document("docs/architecture.md"),
      document("docs/console-api.md"),
      document("README.md")
    ]);

    expect(threatModel).toContain("[OAuth and local Console design delta](oauth-console-threat-model.md)");
    expect(oauthSupport).toContain("[OAuth and local Console design delta](oauth-console-threat-model.md)");
    expect(security).toContain("[OAuth and Console security design delta](oauth-console-threat-model.md)");
    expect(architecture).toContain("[OAuth and Console security design delta](oauth-console-threat-model.md)");
    expect(readme).toContain("[OAuth and Console security design](docs/oauth-console-threat-model.md)");

    expect(delta).toContain("# OAuth broker and local Console design delta");
    expect(delta).toContain("Version 3 can run the approved standards-compatible remote OAuth flow");
    expect(delta).toContain("Issue #85 adds a separately launched local Console control API");
    expect(delta).toContain("Issue #86 adds the optional browser-local Console UI");
    expect(delta).toContain("no provider-revocation client, hosted broker, or background daemon exists");
    expect(delta).toContain("The local CLI can plan bindings, report redacted state, connect, reauthenticate, and delete an exact local credential");
    expect(delta).toContain("The Console control API is distinct from the MCP `/mcp` endpoint.");
    expect(delta).toContain("OAuth access tokens and refresh tokens must not appear in configuration, audit events, diagnostics, logs, query strings, browser storage, or Console UI responses.");
    expect(delta).toContain("An authorization code can arrive only at the bounded callback and must be exchanged without being persisted, logged, audited, or rendered.");
    expect(consoleApi).toContain("# Local Console dashboard and control API");
    expect(consoleApi).toContain("There is no host option, LAN mode, background daemon, or automatic startup.");
    expect(consoleApi).toContain("`POST /api/v1/sessions`");
    expect(consoleApi).toContain("`POST /api/v1/onboarding/native-oauth`");
    expect(consoleApi).toContain("`POST /api/v1/profile-readiness`");
    expect(consoleApi).toContain("provider-declared safe read-only check");
    expect(consoleApi).toContain("GSC accepts only structured account names/descriptions/client-secrets paths");
    expect(consoleApi).toContain("`GET /api/v1/client-snippets?client=<name>`");
    expect(consoleApi).toContain("`POST /api/v1/connections/:ref/test`");
    expect(consoleApi).toContain("`POST /api/v1/connections/:ref/connect`");
    expect(consoleApi).toContain("`POST /api/v1/connections/:ref/reauth`");
    expect(consoleApi).toContain("`DELETE /api/v1/connections/:ref/credential`");
    expect(consoleApi).toContain("must send `Content-Type: application/json` with the JSON body `{}`");
    expect(consoleApi).toContain("It cannot inspect or take over another Miftah process");
    expect(consoleApi).toContain("authenticated `GET` and `HEAD` requests may omit `Origin`");
    expect(consoleApi).toContain("Every request must use the exact listener `Host`");
    expect(consoleApi).toContain("Browser mutations, including bootstrap, must also use the exact listener `Origin`");
    expect(consoleApi).toContain("every mutation still requires exact Origin plus CSRF");
    expect(delta).toContain("requires the exact listener Origin, including scheme, host, and port");
    expect(security).toContain(
      "State-changing browser requests require the exact listener Origin, including scheme, host, and port"
    );
  });

  it("defines protocol go/no-go, abuse cases, residual risks, and implementation evidence", async () => {
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

    expect(delta).toContain("## Focused security test plan and implementation evidence");
    const testPlanStart = delta.indexOf("## Focused security test plan and implementation evidence");
    const testPlanEnd = delta.indexOf("## Implementation gates");
    expect(testPlanStart).toBeGreaterThanOrEqual(0);
    expect(testPlanEnd).toBeGreaterThan(testPlanStart);
    const testPlan = delta.slice(testPlanStart, testPlanEnd);

    for (const row of [
      "| metadata discovery |",
      "| canonical resource comparison |",
      "| PKCE verifier and state |",
      "| redirect and callback |",
      "| replay and lifecycle |",
      "| cross-profile and resource isolation |",
      "| CSRF, Host and Origin |",
      "| request and session limits |",
      "| client registration path |",
      "| Console bootstrap |",
      "| redaction |",
      "| static bearer collision |",
      "| unsupported provider fallback |",
      "| broker boundary |"
    ]) {
      expect(testPlan).toContain(row);
    }
  });

  it("fails closed on issuer provenance and static bearer collisions while specifying the implemented Console bootstrap", async () => {
    const delta = await document("docs/oauth-console-threat-model.md");

    expect(delta).toContain("RFC 9207 `iss`");
    expect(delta).toContain("exactly one `iss`");
    expect(delta).toContain("A callback without that `iss` is a no-go");
    expect(delta).toContain("valid `state` accompanies a code from another issuer");

    expect(delta).toContain("`WWW-Authenticate` `resource_metadata`");
    expect(delta).toContain("OAuth Authorization Server Metadata and OpenID Connect Discovery");
    expect(delta).toContain("`code_challenge_methods_supported` includes `S256`");
    expect(delta).toContain("`client_id_metadata_document_supported` is `true`");
    expect(delta).toContain("Client registration must prefer a pre-registered client.");
    expect(delta).toContain("A verified Client ID Metadata Document is allowed only when `client_id_metadata_document_supported` is `true`");
    expect(delta).toContain("A pre-registered client remains valid without Client ID Metadata or Dynamic Client Registration.");
    expect(delta).toContain("The Client ID Metadata path requires `client_id_metadata_document_supported` to be `true`");
    expect(delta).toContain("The Dynamic Client Registration path requires `registration_endpoint` to be advertised");

    expect(delta).toContain("The approved control credential is not an OAuth token.");
    expect(delta).toContain("It expires after five minutes, is consumed once");
    expect(delta).toContain("Restart or explicit rotation invalidates every session");
    expect(delta).toContain("A profile cannot enable native OAuth while the effective headers for that exact upstream contain an `Authorization` header after profile and upstream headers are merged case-insensitively");
    expect(delta).toContain("Any header whose normalized name is `authorization`, including a profile-level lowercase `authorization` entry or a duplicate case variant, blocks native OAuth until explicitly removed or migrated.");
    expect(delta).toContain("Configuration validation must form that effective header set from profile and upstream headers using case-insensitive header names.");
  });

  it("defines a single canonical resource and secure-store tuple for every native OAuth flow", async () => {
    const delta = await document("docs/oauth-console-threat-model.md");

    expect(delta).toContain("## Canonical resource comparison");
    expect(delta).toContain("Before discovery begins, a native-OAuth connection derives one `canonicalResource` from the exact HTTPS Streamable HTTP MCP endpoint selected for that connection.");
    expect(delta).toContain("That value is the only resource identifier used for the initial unauthenticated MCP request, protected-resource metadata validation, the OAuth `resource` parameter in authorization and token requests, transaction state, the connection record, and the secure-store key.");
    expect(delta).toContain("a canonical resource is an absolute `https` URI with an authority and no userinfo, fragment, or query component");
    expect(delta).toContain("- lowercase the scheme and ASCII/IDNA A-label host;");
    expect(delta).toContain("- omit the default HTTPS port `:443`, and retain another valid port only in unambiguous decimal form;");
    expect(delta).toContain("- represent a root resource without a trailing `/`; preserve the case, octets, and meaningful trailing slash of every non-root path;");
    expect(delta).toContain("- reject literal or percent-encoded dot-segments, invalid percent escapes, Unicode normalization, and ambiguous host forms;");
    expect(delta).toContain("- uppercase percent-escape hex digits and decode only percent-encoded unreserved characters; it must never decode encoded reserved characters such as `%2F`, `%3F`, `%23`, or `%25`;");
    expect(delta).toContain("must already have this exact serialization: after JSON unescaping, it must match `canonicalResource` by Unicode code-point equality.");
    expect(delta).toContain("The `resource_metadata` URL is discovery input, not a replacement resource identifier.");
    expect(delta).toContain("A token audience must never retarget a connection");
    expect(delta).toContain("a key derived from a versioned, unambiguous encoding of the exact profile/upstream/issuer/canonical-resource tuple");
  });

  it("keeps selected client-registration requirements in the focused security test plan", async () => {
    const delta = await document("docs/oauth-console-threat-model.md");
    const testPlanStart = delta.indexOf("## Focused security test plan and implementation evidence");
    const testPlanEnd = delta.indexOf("## Implementation gates", testPlanStart);
    const testPlan = delta.slice(testPlanStart, testPlanEnd);

    expect(testPlan).toContain("A pre-registered client remains valid without Client ID Metadata or Dynamic Client Registration.");
    expect(testPlan).toContain("The Client ID Metadata path requires `client_id_metadata_document_supported` to be `true`");
    expect(testPlan).toContain("The Dynamic Client Registration path requires `registration_endpoint` to be advertised and explicitly approved.");
    expect(testPlan).toContain("Each selected path fails closed only when its required capability is absent or inconsistent.");
  });
});
