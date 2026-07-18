import { describe, expect, it } from "vitest";
import {
  MANAGEMENT_TOOL_DESCRIPTORS,
  managementTools
} from "../src/mcp/server/management-tools.js";

describe("management tool descriptors", () => {
  it("defines every management tool once and projects reviewed MCP annotations", () => {
    const names = MANAGEMENT_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name);
    expect(new Set(names).size).toBe(names.length);

    const visible = managementTools({ delegatedAgentApproval: false });
    const visibleNames = visible.map((tool) => tool.name);
    expect(visibleNames).not.toContain("miftah_approve");
    expect(visibleNames).not.toContain("miftah_deny");

    for (const tool of visible) {
      const descriptor = MANAGEMENT_TOOL_DESCRIPTORS.find((candidate) => candidate.name === tool.name);
      expect(descriptor).toBeDefined();
      expect(tool.annotations).toEqual(descriptor?.annotations);
    }

    const delegated = managementTools({ delegatedAgentApproval: true });
    for (const descriptor of MANAGEMENT_TOOL_DESCRIPTORS) {
      const tool = delegated.find((candidate) => candidate.name === descriptor.name);
      expect(tool).toBeDefined();
      expect(tool?.annotations).toEqual(descriptor.annotations);
    }
  });

  it("classifies pending-approval listing as a read-only local observation", () => {
    const descriptor = MANAGEMENT_TOOL_DESCRIPTORS.find((candidate) => candidate.name === "miftah_list_approvals");

    expect(descriptor).toMatchObject({
      interaction: "observational",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    });
  });

  it("keeps profile discovery and route-preview schemas aligned with their handlers", () => {
    const upstreamTools = MANAGEMENT_TOOL_DESCRIPTORS.find(
      (descriptor) => descriptor.name === "miftah_list_upstream_tools"
    );
    const routePreview = MANAGEMENT_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === "miftah_route_preview");

    expect(upstreamTools?.inputs).toEqual([{ name: "profile", required: false, schema: { type: "string" } }]);
    expect(routePreview?.inputs).toEqual([
      { name: "toolName", required: true, schema: { type: "string" } },
      { name: "args", required: false, schema: { type: "object", additionalProperties: true } }
    ]);
  });

  it("marks privileged or externally active management tools for explicit client review", () => {
    const askNames = MANAGEMENT_TOOL_DESCRIPTORS
      .filter((descriptor) => descriptor.askInClaudeCode)
      .map((descriptor) => descriptor.name);

    expect(askNames).toEqual([
      "miftah_use_profile",
      "miftah_reset_profile",
      "miftah_lock_profile",
      "miftah_unlock_profile",
      "miftah_restart_profile",
      "miftah_verify_identity",
      "miftah_route_preview",
      "miftah_approve",
      "miftah_deny"
    ]);
  });
});
