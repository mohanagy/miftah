import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  planNativeOAuthAccountAddition,
  planNativeOAuthFirstRunConfiguration,
  runNativeOAuthAccountAddition
} from "../src/setup/native-oauth-onboarding.js";
import {
  startOAuthCompatibilityProbe,
  type OAuthCompatibilityProbe
} from "./helpers/fake-remote-upstream.js";

const connectionId = "7519a443-409f-4f44-9074-75d2e94f11f4";
const connectionRef = `oauthconn:${connectionId}`;
const secondConnectionId = "8996e351-b0bd-4d3e-9c68-9f956e0b3bb2";
const secondConnectionRef = `oauthconn:${secondConnectionId}`;

describe("native OAuth first-run onboarding", () => {
  const upstreams: OAuthCompatibilityProbe[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("derives one strict dynamic OAuth configuration from only a canonical remote MCP endpoint", async () => {
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    upstreams.push(upstream);

    const plan = await planNativeOAuthFirstRunConfiguration(
      {
        name: "posthog-work",
        profile: "production",
        description: "Production analytics account",
        resource: upstream.streamableHttpUrl
      },
      {
        generateConnectionRef: () => connectionId,
        fetch: upstream.fetch
      }
    );

    expect(plan).toMatchObject({
      connectionRef,
      discovery: {
        resource: "https://mcp.example.test/mcp",
        issuer: "https://mcp.example.test",
        clientRegistration: "dynamic",
        advertisedScopes: ["mcp:tools"]
      },
      config: {
        version: "3",
        name: "posthog-work",
        defaultProfile: "production",
        upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
        profiles: { production: { description: "Production analytics account" } },
        oauth: {
          connections: {
            [connectionRef]: {
              profile: "production",
              upstream: "default",
              resource: "https://mcp.example.test/mcp",
              issuer: "https://mcp.example.test",
              clientRegistration: "dynamic",
              scopes: ["mcp:tools"]
            }
          }
        }
      }
    });
    expect(plan.actions).toEqual([
      "Created profile 'production'.",
      "Discovered standards-based OAuth for profile 'production'.",
      "Added OAuth connection for profile 'production' and upstream 'default'."
    ]);
    expect(upstream.discoveryRequests()).toEqual([
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server"
    ]);
    expect(upstream.registrationRequests()).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain("fixture-access-token");
  });

  it("prefers a reviewed Client ID Metadata Document when the authorization server advertises CIMD", async () => {
    const upstream = await startOAuthCompatibilityProbe({
      publicBaseUrl: "https://mcp.example.test",
      dynamicRegistrationSupported: false
    });
    upstreams.push(upstream);
    const clientMetadataUrl = "https://client.example.test/oauth/miftah.json";

    const plan = await planNativeOAuthFirstRunConfiguration(
      {
        name: "posthog-work",
        profile: "production",
        resource: upstream.streamableHttpUrl,
        clientMetadataUrl
      },
      {
        generateConnectionRef: () => connectionId,
        fetch: upstream.fetch
      }
    );

    expect(plan.discovery.clientRegistration).toBe(`client-id-metadata:${clientMetadataUrl}`);
    expect(plan.config).toMatchObject({
      oauth: {
        connections: {
          [connectionRef]: { clientRegistration: `client-id-metadata:${clientMetadataUrl}` }
        }
      }
    });
    expect(upstream.registrationRequests()).toEqual([]);
  });

  it("rejects an unsafe CIMD URL and uses bounded DCR only when CIMD is unavailable", async () => {
    const upstream = await startOAuthCompatibilityProbe({
      publicBaseUrl: "https://mcp.example.test",
      clientMetadataDocumentSupported: false
    });
    upstreams.push(upstream);

    await expect(planNativeOAuthFirstRunConfiguration(
      {
        name: "posthog-work",
        profile: "production",
        resource: upstream.streamableHttpUrl,
        clientMetadataUrl: "https://client.example.test/"
      },
      { generateConnectionRef: () => connectionId, fetch: upstream.fetch }
    )).rejects.toMatchObject({ code: "OAUTH_CLIENT_REGISTRATION_UNSUPPORTED" });

    const fallback = await planNativeOAuthFirstRunConfiguration(
      {
        name: "posthog-work",
        profile: "production",
        resource: upstream.streamableHttpUrl,
        clientMetadataUrl: "https://client.example.test/oauth/miftah.json"
      },
      { generateConnectionRef: () => connectionId, fetch: upstream.fetch }
    );
    expect(fallback.discovery.clientRegistration).toBe("dynamic");
    expect(upstream.registrationRequests()).toEqual([]);
  });

  it("refuses endpoint-first setup when the discovered server cannot dynamically register a public client", async () => {
    const requestPaths: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestPaths.push(url.toString());
      if (url.toString() === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
        return new Response("not found", { status: 404 });
      }
      if (url.toString() === "https://mcp.example.test/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: "https://mcp.example.test/mcp",
          authorization_servers: ["https://auth.example.test"],
          scopes_supported: ["analytics:read"]
        });
      }
      if (url.toString() === "https://auth.example.test/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://auth.example.test",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true
        });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    await expect(
      planNativeOAuthFirstRunConfiguration(
        {
          name: "analytics",
          profile: "production",
          resource: "https://mcp.example.test/mcp"
        },
        { generateConnectionRef: () => connectionId, fetch }
      )
    ).rejects.toMatchObject({ code: "OAUTH_CLIENT_REGISTRATION_UNSUPPORTED" });
    expect(requestPaths).toEqual([
      "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
      "https://mcp.example.test/.well-known/oauth-protected-resource",
      "https://auth.example.test/.well-known/oauth-authorization-server"
    ]);
  });

  it("plans another named native OAuth account without changing the existing account or binding", async () => {
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    upstreams.push(upstream);
    const input = {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { work: { description: "Work analytics" } },
      oauth: {
        connections: {
          [connectionRef]: {
            profile: "work",
            upstream: "default",
            resource: "https://mcp.example.test/mcp",
            issuer: "https://mcp.example.test",
            clientRegistration: "dynamic",
            scopes: ["mcp:tools"]
          }
        }
      }
    };
    const original = structuredClone(input);

    const plan = await planNativeOAuthAccountAddition(input, {
      profile: "personal",
      description: "Personal analytics",
      upstream: "default",
      makeDefault: true
    }, {
      generateConnectionRef: () => secondConnectionId,
      fetch: upstream.fetch
    });

    expect(plan).toMatchObject({
      connectionRef: secondConnectionRef,
      profile: "personal",
      upstream: "default",
      config: {
        defaultProfile: "personal",
        profiles: {
          work: { description: "Work analytics" },
          personal: { description: "Personal analytics" }
        },
        oauth: {
          connections: {
            [connectionRef]: { profile: "work" },
            [secondConnectionRef]: {
              profile: "personal",
              upstream: "default",
              resource: "https://mcp.example.test/mcp",
              issuer: "https://mcp.example.test",
              clientRegistration: "dynamic",
              scopes: ["mcp:tools"]
            }
          }
        }
      }
    });
    expect(plan.actions).toEqual([
      "Created profile 'personal'.",
      "Discovered standards-based OAuth for profile 'personal'.",
      "Added OAuth connection for profile 'personal' and upstream 'default'.",
      "Set durable default profile to 'personal'."
    ]);
    expect(input).toEqual(original);
    expect(upstream.registrationRequests()).toEqual([]);
  });

  it("rejects a duplicate account name before metadata discovery", async () => {
    const input = {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { work: {} }
    };
    const fetch = async (): Promise<Response> => {
      throw new Error("metadata discovery must not run for a duplicate profile");
    };

    await expect(planNativeOAuthAccountAddition(input, {
      profile: "work",
      upstream: "default"
    }, { fetch })).rejects.toMatchObject({ code: "PROFILE_ALREADY_EXISTS" });
  });

  it("requires an explicit named upstream for multi-upstream account additions", async () => {
    const input = {
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstreams: {
        analytics: { transport: "streamable-http", url: "https://mcp.example.test/mcp" }
      },
      profiles: { work: {} }
    };
    const noFetch = async (): Promise<Response> => {
      throw new Error("metadata discovery must not run without an upstream selection");
    };

    await expect(planNativeOAuthAccountAddition(input, { profile: "personal" }, { fetch: noFetch }))
      .rejects.toMatchObject({ code: "OAUTH_CONNECTION_TARGET_REQUIRED" });

    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    upstreams.push(upstream);
    await expect(planNativeOAuthAccountAddition(input, {
      profile: "personal",
      upstream: "analytics"
    }, {
      generateConnectionRef: () => secondConnectionId,
      fetch: upstream.fetch
    })).resolves.toMatchObject({
      profile: "personal",
      upstream: "analytics",
      discovery: { resource: "https://mcp.example.test/mcp" }
    });
  });

  it("reports the guarded migration backup after adding an OAuth account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-native-oauth-account-backup-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "analytics.json");
    const original = `${JSON.stringify({
      version: "2",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { work: {} }
    }, null, 2)}\n`;
    await writeFile(configPath, original, "utf8");
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    upstreams.push(upstream);

    const result = await runNativeOAuthAccountAddition({
      configPath,
      profile: "personal",
      upstream: "default"
    }, {
      generateConnectionRef: () => secondConnectionId,
      fetch: upstream.fetch
    });

    expect(result).toHaveProperty("backupPath", expect.stringContaining("analytics.json.miftah-backup-"));
    const backupPath = (result as { readonly backupPath?: string }).backupPath;
    expect(backupPath).toBeDefined();
    expect(await readFile(backupPath!, "utf8")).toBe(original);
  });
});
