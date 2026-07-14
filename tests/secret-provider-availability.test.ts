import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  diagnoseConfiguredSecretProviders,
  scanConfiguredExternalSecretProviders
} from "../src/secrets/secret-provider-availability.js";

describe("secret provider availability", () => {
  it("returns no checks when no external providers are configured", async () => {
    await expect(diagnoseConfiguredSecretProviders([])).resolves.toEqual([]);
  });

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
          headers: { Authorization: "${LOCAL_TOKEN}" },
          upstreams: {
            ignored: { env: { TOKEN: "secretref:plain://not-an-external-provider" } }
          }
        }
      },
      server: { http: { authToken: "secretref:op://vault/item/field" } }
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

  it.runIf(process.platform !== "win32")(
    "finds executable providers without invoking their fixture programs",
    async () => {
      const directory = join(tmpdir(), `miftah-provider-availability-${randomUUID()}`);
      const sentinel = join(directory, "provider-was-invoked");
      const fixture = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.MIFTAH_AVAILABILITY_SENTINEL, "invoked");
`;
      await mkdir(directory, { recursive: true });
      try {
        for (const command of ["secret-tool", "op"]) {
          const path = join(directory, command);
          await writeFile(path, fixture, { mode: 0o700 });
          await chmod(path, 0o700);
        }

        await expect(
          diagnoseConfiguredSecretProviders(["keychain", "op"], {
            platform: "linux",
            environment: {
              PATH: directory,
              MIFTAH_AVAILABILITY_SENTINEL: sentinel
            }
          })
        ).resolves.toEqual([
          { provider: "keychain", available: true },
          { provider: "op", available: true }
        ]);
        await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
  );

  it.runIf(process.platform !== "win32")(
    "uses the supplied Windows SystemRoot while checking keychain availability",
    async () => {
      const directory = join(tmpdir(), `miftah-provider-system-root-${randomUUID()}`);
      const fakePowerShell = "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
      const originalDirectory = process.cwd();
      await mkdir(directory, { recursive: true });
      process.chdir(directory);
      try {
        await writeFile(fakePowerShell, "", { mode: 0o700 });
        await chmod(fakePowerShell, 0o700);

        await expect(
          diagnoseConfiguredSecretProviders(["keychain"], {
            platform: "win32",
            environment: { SystemRoot: "/" }
          })
        ).resolves.toEqual([{ provider: "keychain", available: true }]);
      } finally {
        process.chdir(originalDirectory);
        await rm(directory, { force: true, recursive: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "does not fall back to the host SystemRoot when an injected root is invalid",
    async () => {
      await expect(
        diagnoseConfiguredSecretProviders(["keychain"], {
          platform: "win32",
          environment: { SystemRoot: "not-an-absolute-windows-path" }
        })
      ).resolves.toEqual([{ provider: "keychain", available: false }]);
    }
  );

  it("deduplicates provider names and reports unsupported keychain platforms as unavailable", async () => {
    await expect(
      diagnoseConfiguredSecretProviders(["keychain", "keychain", "op"], {
        platform: "freebsd",
        environment: {}
      })
    ).resolves.toEqual([
      { provider: "keychain", available: false },
      { provider: "op", available: false }
    ]);
  });

  it.runIf(process.platform !== "darwin")(
    "checks the fixed macOS keychain executable without invoking it",
    async () => {
      await expect(
        diagnoseConfiguredSecretProviders(["keychain"], {
          platform: "darwin",
          environment: {}
        })
      ).resolves.toEqual([{ provider: "keychain", available: false }]);
    }
  );
});
