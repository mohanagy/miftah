import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("audit logical suite durability boundary", () => {
  it("isolates logical filesystem assertions from host sync latency without weakening durability coverage", async () => {
    const logicalSyncHook =
      /beforeEach\s*\(\s*async\s*\(\)\s*=>\s*\{\s*await\s+stubFileSyncForLogicalTest\(\);\s*\}\s*\);/s;
    const [
      integritySuite,
      readerSuite,
      consoleApplicationSuite,
      auditDurabilitySuite,
      integrityDurabilitySuite,
      oauthRenameSuite,
      oauthRenameDurabilitySuite
    ] = await Promise.all([
      readFile(new URL("./audit-integrity.test.ts", import.meta.url), "utf8"),
      readFile(new URL("./audit-log-reader.test.ts", import.meta.url), "utf8"),
      readFile(new URL("./console-application-service.test.ts", import.meta.url), "utf8"),
      readFile(new URL("./audit.test.ts", import.meta.url), "utf8"),
      readFile(new URL("./audit-integrity-durability.test.ts", import.meta.url), "utf8"),
      readFile(new URL("./oauth-profile-rename-transaction.test.ts", import.meta.url), "utf8"),
      readFile(new URL("./oauth-profile-rename-durability.test.ts", import.meta.url), "utf8")
    ]);

    expect(integritySuite).toMatch(logicalSyncHook);
    expect(readerSuite).toMatch(logicalSyncHook);
    expect(consoleApplicationSuite).toMatch(logicalSyncHook);
    expect(auditDurabilitySuite).not.toContain("stubFileSyncForLogicalTest");
    expect(integrityDurabilitySuite).toContain('algorithm: "sha256-chain"');
    expect(integrityDurabilitySuite).not.toContain("stubFileSyncForLogicalTest");
    expect(oauthRenameSuite).toMatch(logicalSyncHook);
    expect(oauthRenameDurabilitySuite).toContain("runOAuthProfileRenameTransaction");
    expect(oauthRenameDurabilitySuite).not.toContain("stubFileSyncForLogicalTest");
  });
});
