import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLogger } from "../src/audit/audit-logger.js";
import { AuditTrail } from "../src/audit/audit-trail.js";
import { AuditTrailOAuthConnectionAuditSink } from "../src/oauth/audit.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OAuth audit sink", () => {
  it("writes only redacted connection lifecycle and identity metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-oauth-audit-"));
    directories.push(directory);
    const path = join(directory, "audit.jsonl");
    const sink = new AuditTrailOAuthConnectionAuditSink(
      new AuditTrail("analytics", new AuditLogger(path, { secretValues: ["fixture-access-token", "fixture-refresh-token"] }))
    );

    await sink.record({
      action: "connect",
      profile: "work",
      upstream: "default",
      credentialState: "connected",
      identityState: "unverified",
      status: "success"
    });

    const event = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(event).toMatchObject({
      wrapper: "analytics",
      kind: "lifecycle",
      operation: "oauth/connect",
      name: "connection",
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      oauthConnectionState: "connected",
      oauthIdentityState: "unverified",
      status: "success"
    });
    expect(event).not.toHaveProperty("connectionRef");
    expect(event).not.toHaveProperty("canonicalResource");
    expect(event).not.toHaveProperty("issuer");
    expect(JSON.stringify(event)).not.toContain("fixture-access-token");
    expect(JSON.stringify(event)).not.toContain("fixture-refresh-token");
  });
});
