import { afterEach, describe, expect, it } from "vitest";
import { createOAuthConnectionBinding } from "../src/oauth/connection-types.js";
import { RemoteOAuthCredentialRefresher } from "../src/oauth/remote-oauth-credential-refresher.js";
import {
  startOAuthCompatibilityProbe,
  type OAuthCompatibilityProbe
} from "./helpers/fake-remote-upstream.js";

describe("remote OAuth credential refresher", () => {
  const upstreams: OAuthCompatibilityProbe[] = [];

  afterEach(async () => {
    await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  });

  it("revalidates exact discovery and rotates a profile-bound refresh token", async () => {
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    upstreams.push(upstream);
    const binding = createOAuthConnectionBinding({
      configIdentity: "a".repeat(64),
      connectionRef: "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5",
      profile: "work",
      upstream: "default",
      resource: upstream.streamableHttpUrl,
      issuer: "https://mcp.example.test",
      clientRegistration: "dynamic",
      scopes: ["mcp:tools"]
    });
    const refresher = new RemoteOAuthCredentialRefresher({
      fetch: upstream.fetch,
      now: () => new Date("2026-07-22T00:00:00.000Z")
    });

    await expect(
      refresher.refresh(
        binding,
        {
          accessToken: "fixture-expired-access-token",
          refreshToken: "fixture-refresh-token",
          expiresAt: "2026-07-21T00:00:00.000Z",
          clientId: "miftah-compatibility-client"
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      accessToken: "fixture-refreshed-access-token",
      refreshToken: "fixture-rotated-refresh-token",
      expiresAt: "2026-07-22T01:00:00.000Z",
      scopes: ["mcp:tools"],
      clientId: "miftah-compatibility-client"
    });
    expect(upstream.tokenExchanges()).toEqual([
      expect.objectContaining({
        clientId: "miftah-compatibility-client",
        grantType: "refresh_token",
        resource: upstream.streamableHttpUrl
      })
    ]);
  });

  it("retains RFC 9207 support proof when discovery falls back to OpenID Connect metadata", async () => {
    const upstream = await startOAuthCompatibilityProbe({
      publicBaseUrl: "https://mcp.example.test",
      discoveryKind: "oidc"
    });
    upstreams.push(upstream);
    const binding = createOAuthConnectionBinding({
      configIdentity: "a".repeat(64),
      connectionRef: "oauthconn:1d915a13-f8a5-45e0-8343-1e82e0939129",
      profile: "work",
      upstream: "default",
      resource: upstream.streamableHttpUrl,
      issuer: "https://mcp.example.test",
      clientRegistration: "dynamic",
      scopes: ["mcp:tools"]
    });
    const refresher = new RemoteOAuthCredentialRefresher({ fetch: upstream.fetch });

    await expect(
      refresher.refresh(
        binding,
        {
          accessToken: "fixture-expired-access-token",
          refreshToken: "fixture-refresh-token",
          clientId: "miftah-compatibility-client"
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ accessToken: "fixture-refreshed-access-token" });
    expect(upstream.discoveryRequests()).toContain("/.well-known/openid-configuration");
  });

  it("classifies a locally cancelled refresh separately from reauthentication", async () => {
    const binding = createOAuthConnectionBinding({
      configIdentity: "a".repeat(64),
      connectionRef: "oauthconn:9428bd06-437b-47f4-9343-549dcb880d91",
      profile: "work",
      upstream: "default",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://mcp.example.test",
      clientRegistration: "pre-registered:miftah-desktop",
      scopes: ["mcp:tools"]
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      new RemoteOAuthCredentialRefresher().refresh(
        binding,
        { accessToken: "fixture-access-token", refreshToken: "fixture-refresh-token" },
        controller.signal
      )
    ).rejects.toMatchObject({ code: "OAUTH_REFRESH_CANCELLED" });
  });
});
