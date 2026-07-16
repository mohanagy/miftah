import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  startOAuthCompatibilityProbe,
  type OAuthCompatibilityProbe
} from "./helpers/fake-remote-upstream.js";

class DeterministicOAuthClientProvider implements OAuthClientProvider {
  readonly redirectUrl = "http://127.0.0.1:43179/callback";
  private client?: OAuthClientInformationMixed;
  private savedTokens?: OAuthTokens;
  private verifier?: string;
  private redirect?: URL;

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Miftah deterministic OAuth compatibility probe",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  }

  state(): string {
    return "miftah-compatibility-state";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.client = client;
  }

  tokens(): OAuthTokens | undefined {
    return this.savedTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.savedTokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.redirect = new URL(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("The compatibility probe did not receive a PKCE verifier.");
    return this.verifier;
  }

  authorizationRedirect(): URL | undefined {
    return this.redirect ? new URL(this.redirect) : undefined;
  }
}

describe("standards-compatible remote OAuth probe", () => {
  const upstreams: OAuthCompatibilityProbe[] = [];

  afterEach(async () => {
    await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  });

  it("proves discovery, dynamic registration, PKCE exchange, and bearer retry without a live provider", async () => {
    const upstream = await startOAuthCompatibilityProbe();
    upstreams.push(upstream);
    const provider = new DeterministicOAuthClientProvider();
    const firstTransport = new StreamableHTTPClientTransport(new URL(upstream.streamableHttpUrl), { authProvider: provider });
    const firstClient = new Client({ name: "miftah-oauth-compatibility-probe", version: "1.0.0" });

    try {
      await expect(firstClient.connect(firstTransport)).rejects.toBeInstanceOf(UnauthorizedError);

      const authorizationRedirect = provider.authorizationRedirect();
      if (!authorizationRedirect) throw new Error("The compatibility probe did not produce an authorization redirect.");
      expect(authorizationRedirect.pathname).toBe("/oauth/authorize");
      expect(authorizationRedirect.searchParams.get("response_type")).toBe("code");
      expect(authorizationRedirect.searchParams.get("client_id")).toBe("miftah-compatibility-client");
      expect(authorizationRedirect.searchParams.get("redirect_uri")).toBe(provider.redirectUrl);
      expect(authorizationRedirect.searchParams.get("resource")).toBe(upstream.streamableHttpUrl);
      expect(authorizationRedirect.searchParams.get("scope")).toBe("mcp:tools");
      expect(authorizationRedirect.searchParams.get("state")).toBe("miftah-compatibility-state");
      expect(authorizationRedirect.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationRedirect.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(upstream.discoveryRequests()).toEqual([
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-authorization-server"
      ]);
      expect(upstream.registrationRequests()).toEqual([
        {
          clientName: "Miftah deterministic OAuth compatibility probe",
          redirectUri: provider.redirectUrl,
          scope: "mcp:tools"
        }
      ]);

      const authorizationResponse = await fetch(authorizationRedirect, { redirect: "manual" });
      expect(authorizationResponse.status).toBe(302);
      const callbackLocation = authorizationResponse.headers.get("location");
      if (!callbackLocation) throw new Error("The compatibility probe did not produce an authorization callback.");
      const callback = new URL(callbackLocation);
      expect(callback.origin + callback.pathname).toBe(provider.redirectUrl);
      expect(callback.searchParams.get("code")).toBe("fixture-authorization-code");
      expect(callback.searchParams.get("state")).toBe("miftah-compatibility-state");

      await firstTransport.finishAuth("fixture-authorization-code");
      expect(upstream.tokenExchanges()).toEqual([
        {
          clientId: "miftah-compatibility-client",
          codeWasExpected: true,
          codeVerifierPresent: true,
          pkceVerified: true,
          grantType: "authorization_code",
          redirectUri: provider.redirectUrl,
          resource: upstream.streamableHttpUrl
        }
      ]);

      const authenticatedTransport = new StreamableHTTPClientTransport(new URL(upstream.streamableHttpUrl), {
        authProvider: provider
      });
      const authenticatedClient = new Client({ name: "miftah-oauth-compatibility-probe", version: "1.0.0" });
      try {
        await authenticatedClient.connect(authenticatedTransport);
        expect((await authenticatedClient.listTools()).tools.map((tool) => tool.name)).toEqual(["whoami"]);
        expect(upstream.authenticatedMcpRequests()).toBeGreaterThanOrEqual(2);
        expect(upstream.unauthenticatedMcpRequests()).toBe(1);
      } finally {
        await authenticatedClient.close();
        await authenticatedTransport.close();
      }
    } finally {
      await firstClient.close();
      await firstTransport.close();
    }
  });

  it("rejects a token request with a verifier that does not match the issued PKCE challenge", async () => {
    const upstream = await startOAuthCompatibilityProbe();
    upstreams.push(upstream);
    const authorizationUrl = new URL("/oauth/authorize", upstream.streamableHttpUrl);
    authorizationUrl.searchParams.set("client_id", "miftah-compatibility-client");
    authorizationUrl.searchParams.set("redirect_uri", "http://127.0.0.1:43179/callback");
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("state", "miftah-compatibility-state");
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("code_challenge", "a".repeat(43));

    const authorizationResponse = await fetch(authorizationUrl, { redirect: "manual" });
    expect(authorizationResponse.status).toBe(302);

    const tokenResponse = await fetch(new URL("/oauth/token", upstream.streamableHttpUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "miftah-compatibility-client",
        code: "fixture-authorization-code",
        code_verifier: "fixture-mismatched-verifier",
        grant_type: "authorization_code",
        redirect_uri: "http://127.0.0.1:43179/callback",
        resource: upstream.streamableHttpUrl
      })
    });

    expect(tokenResponse.status).toBe(400);
    await expect(tokenResponse.json()).resolves.toEqual({ error: "invalid_grant" });
    expect(upstream.tokenExchanges()).toEqual([
      {
        clientId: "miftah-compatibility-client",
        codeWasExpected: true,
        codeVerifierPresent: true,
        pkceVerified: false,
        grantType: "authorization_code",
        redirectUri: "http://127.0.0.1:43179/callback",
        resource: upstream.streamableHttpUrl
      }
    ]);
  });
});
