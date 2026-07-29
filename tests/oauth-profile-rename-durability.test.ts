import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readConfigMigrationSource } from "../src/cli/migrate-config.js";
import { OAuthConnectionRegistry } from "../src/oauth/connection-registry.js";
import {
  createOAuthConfigIdentity,
  createOAuthConnectionBinding,
  parseOAuthConnectionRef
} from "../src/oauth/connection-types.js";
import {
  canonicalOAuthProfileRenameConfigPath,
  oauthProfileRenameJournalPath,
  runOAuthProfileRenameTransaction
} from "../src/oauth/profile-rename-transaction.js";
import { planProfileRename } from "../src/setup/profile-rename-onboarding.js";
import {
  MemoryProfileRenameCredentialStore,
  MemoryProfileRenameMetadataStore
} from "./helpers/profile-rename-oauth-dependencies.js";

const connectionRef = "oauthconn:11111111-1111-4111-8111-111111111111";

describe("native OAuth profile-rename durability", () => {
  it("commits one exact binding migration through the real filesystem sync boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-profile-rename-durability-"));
    const configPath = join(directory, "remote-analytics.json");
    try {
      const config = {
        version: "3",
        name: "remote-analytics",
        defaultProfile: "work",
        upstream: { transport: "streamable-http", url: "https://mcp.example.com/mcp" },
        profiles: { work: {}, personal: {} },
        oauth: {
          connections: {
            [connectionRef]: {
              profile: "work",
              upstream: "default",
              resource: "https://mcp.example.com/mcp",
              issuer: "https://auth.example.com",
              clientRegistration: "dynamic",
              scopes: ["openid"]
            }
          }
        }
      } as const;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      const source = await readConfigMigrationSource(configPath);
      const candidate = planProfileRename(config, {
        configPath,
        profile: "work",
        newProfile: "studio"
      }).config;
      const canonicalConfigPath = await canonicalOAuthProfileRenameConfigPath(configPath);
      const binding = (profile: string) =>
        createOAuthConnectionBinding({
          configIdentity: createOAuthConfigIdentity(canonicalConfigPath),
          connectionRef: parseOAuthConnectionRef(connectionRef),
          profile,
          upstream: "default",
          resource: "https://mcp.example.com/mcp",
          issuer: "https://auth.example.com",
          clientRegistration: "dynamic",
          scopes: ["openid"]
        });
      const from = binding("work");
      const to = binding("studio");
      const credentials = new MemoryProfileRenameCredentialStore();
      const registry = new OAuthConnectionRegistry(
        new MemoryProfileRenameMetadataStore(),
        () => "2030-01-02T03:04:05.000Z"
      );
      await credentials.save(from, { accessToken: "fixture-access-token" });
      await registry.create(from);

      await expect(
        runOAuthProfileRenameTransaction(
          { configPath, source, candidate, bindings: [{ from, to }] },
          { credentialStore: credentials, registry }
        )
      ).resolves.toMatchObject({ backupPath: expect.any(String) });

      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        defaultProfile: "studio",
        profiles: { studio: {}, personal: {} },
        oauth: { connections: { [connectionRef]: { profile: "studio" } } }
      });
      await expect(readFile(oauthProfileRenameJournalPath(canonicalConfigPath), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
