import { describe, expect, it } from "vitest";
import { OAuthMetadataFetchGuard } from "../src/oauth/oauth-metadata-fetch-guard.js";

describe("OAuth metadata fetch guard", () => {
  it("does not let metadata from another issuer origin seed RFC 9207 support", async () => {
    const configuredIssuer = "https://issuer.example.test";
    const guard = new OAuthMetadataFetchGuard(async () =>
      Response.json({
        issuer: configuredIssuer,
        authorization_response_iss_parameter_supported: true
      })
    );

    await guard.fetch("https://poison.example.test/.well-known/oauth-authorization-server");

    expect(guard.issuerResponseSupported(configuredIssuer)).toBe(false);
  });

  it("binds RFC 9207 support to the exact issuer path represented by the metadata URL", async () => {
    const requestedIssuer = "https://issuer.example.test/tenant-a";
    const mismatchedIssuer = "https://issuer.example.test/tenant-b";
    const exact = new OAuthMetadataFetchGuard(async () =>
      Response.json({
        issuer: requestedIssuer,
        authorization_response_iss_parameter_supported: true
      })
    );
    const mismatched = new OAuthMetadataFetchGuard(async () =>
      Response.json({
        issuer: mismatchedIssuer,
        authorization_response_iss_parameter_supported: true
      })
    );
    const metadataUrl = "https://issuer.example.test/.well-known/oauth-authorization-server/tenant-a";

    await exact.fetch(metadataUrl);
    await mismatched.fetch(metadataUrl);

    expect(exact.issuerResponseSupported(requestedIssuer)).toBe(true);
    expect(mismatched.issuerResponseSupported(mismatchedIssuer)).toBe(false);
  });

  it("does not buffer or trust an oversized authorization metadata response", async () => {
    const issuer = "https://issuer.example.test";
    const oversizedMetadata = JSON.stringify({
      issuer,
      authorization_response_iss_parameter_supported: true,
      padding: "x".repeat(70 * 1_024)
    });
    const guard = new OAuthMetadataFetchGuard(async () => new Response(oversizedMetadata, { status: 200 }));

    await guard.fetch(`${issuer}/.well-known/oauth-authorization-server`);

    expect(guard.issuerResponseSupported(issuer)).toBe(false);
  });
});
