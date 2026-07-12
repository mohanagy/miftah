import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function document(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("secret provider documentation contract", () => {
  it("documents the strict external-reference grammar and bounded timeout", async () => {
    const config = await document("docs/config.md");

    for (const text of [
      "secretref:keychain://<service>/<account>",
      "secretref:op://<vault>/<item>/<field>",
      "providerTimeoutMs",
      "100 ms",
      "120,000 ms",
      "10 seconds",
      "OP_SERVICE_ACCOUNT_TOKEN"
    ]) {
      expect(config).toContain(text);
    }
  });

  it("documents redaction, Windows containment, and scoped doctor behavior", async () => {
    const [readme, cli, security, architecture] = await Promise.all([
      document("README.md"),
      document("docs/cli.md"),
      document("docs/security.md"),
      document("docs/architecture.md")
    ]);

    expect(readme).toContain("secretref:keychain://");
    expect(readme).toContain("secretref:op://");
    expect(cli).toContain("DOCTOR_SECRET_PROVIDERS");
    expect(cli).toContain("target-scoped");
    expect(security).toContain("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE");
    expect(architecture).toContain("typed provider");
  });

  it("publishes only the secret configuration type and records the delivery", async () => {
    const [libraryApi, changelog] = await Promise.all([
      document("docs/library-api.md"),
      document("CHANGELOG.md")
    ]);

    expect(libraryApi).toContain("SecretsConfig");
    expect(changelog).toContain("[#22]");
  });
});
