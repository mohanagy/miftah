import { describe, expect, it } from "vitest";
import { OAuthMetadataFetchGuard } from "../src/oauth/oauth-metadata-fetch-guard.js";

describe("OAuth metadata fetch guard", () => {
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
