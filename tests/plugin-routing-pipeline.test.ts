import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditTrail } from "../src/audit/audit-trail.js";
import { IdentityManager } from "../src/identity/identity-manager.js";
import { OperationPipeline } from "../src/mcp/server/operation-pipeline.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { loadPluginRegistry } from "../src/plugins/plugin-registry.js";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { RoutingEngine } from "../src/routing/routing-engine.js";
import { SecretRedactor } from "../src/secrets/redact.js";
import type { UpstreamProcessManager } from "../src/upstream/upstream-process-manager.js";

describe("plugin routing pipeline", () => {
  it("uses isolated matcher bindings before fallback when executing an operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-plugin-routing-pipeline-"));
    const pluginPath = join(directory, "routing-plugin.mjs");
    await writeFile(
      pluginPath,
      `export default {
  apiVersion: "1",
  id: "pipeline-routing",
  kind: "routing-matcher",
  async match(request) {
    return {
      bindings: request.signals.some((signal) =>
        signal.provider === "github" && signal.kind === "repository" && signal.value === "owner/repository"
      ) ? ["owner-work"] : []
    };
  }
};\n`,
      "utf8"
    );
    const plugins = await loadPluginRegistry({
      allowlist: [
        {
          id: "pipeline-routing",
          kind: "routing-matcher",
          path: pluginPath,
          bindings: { "owner-work": "work" }
        }
      ]
    });
    const profiles = new ProfileManager({ defaultProfile: "personal", profiles: { personal: {}, work: {} } });
    const pipeline = new OperationPipeline({
      profiles,
      routing: new RoutingEngine({ fallback: "block" }, "personal", "personal", { personal: {}, work: {} }, plugins),
      policy: new PolicyEngine(),
      upstreams: { get: async () => ({}) } as unknown as UpstreamProcessManager,
      redactor: new SecretRedactor(),
      routingContext: async () => ({ context: {}, evidence: { cwd: "", fileRoots: [] }, profileHints: [] }),
      identities: { requiresVerification: () => false } as unknown as IdentityManager,
      approvals: { requireApproval: async () => undefined }
    });
    const audit = new AuditTrail("test").beginOperation({
      operation: "tools/call",
      name: "github_issue_get",
      sourceProfile: "personal"
    });

    try {
      await expect(
        pipeline.execute(
          {
            source: profiles.current(),
            operation: "tools/call",
            routingName: "github_issue_get",
            policyName: "github_issue_get",
            name: "github_issue_get",
            args: { repository: "owner/repository", password: "must-not-reach-plugin" },
            resolveTarget: async (profile) => ({
              name: profile,
              execute: async () => "routed-through-plugin",
              redact: (result) => result
            })
          },
          audit
        )
      ).resolves.toBe("routed-through-plugin");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
