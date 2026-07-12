import { describe, expect, it } from "vitest";
import {
  diagnoseConfiguredSecretProviders,
  scanConfiguredExternalSecretProviders
} from "../src/secrets/secret-provider-availability.js";

describe("secret provider availability", () => {
  it("finds only external providers without retaining secret reference payloads", () => {
    const configured = scanConfiguredExternalSecretProviders({
      version: "1",
      name: "provider-availability",
      defaultProfile: "default",
      upstream: {
        transport: "stdio",
        command: "node",
        env: { KEYCHAIN_TOKEN: "secretref:keychain://service/account" }
      },
      profiles: {
        default: {
          headers: { Authorization: "secretref:op://vault/item/field" },
          upstreams: {
            ignored: { env: { TOKEN: "secretref:plain://not-an-external-provider" } }
          }
        }
      }
    });

    expect(configured).toEqual(["keychain", "op"]);
    expect(JSON.stringify(configured)).not.toContain("service");
    expect(JSON.stringify(configured)).not.toContain("vault");
  });

  it("reports missing Linux keychain and 1Password executables without invocation", async () => {
    await expect(
      diagnoseConfiguredSecretProviders(["keychain", "op"], {
        platform: "linux",
        environment: { PATH: "/definitely/not/a/provider/bin" }
      })
    ).resolves.toEqual([
      { provider: "keychain", available: false },
      { provider: "op", available: false }
    ]);
  });
});
