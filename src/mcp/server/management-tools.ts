import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export type ManagementToolInteraction = "observational" | "state-changing" | "external-probe";
export type ManagementToolAvailability = "always" | "delegated-agent";

export interface ManagementToolInput {
  readonly name: string;
  readonly required: boolean;
  readonly schema: Readonly<Record<string, unknown>>;
}

/** One authoritative management-tool contract for MCP, onboarding, and client guidance. */
export interface ManagementToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputs: readonly ManagementToolInput[];
  readonly interaction: ManagementToolInteraction;
  readonly availability: ManagementToolAvailability;
  /** Client-side defense in depth only; Miftah remains the authorization boundary. */
  readonly askInClaudeCode: boolean;
  readonly annotations: ToolAnnotations;
}

interface ManagementToolOptions {
  readonly delegatedAgentApproval: boolean;
}

/** Creates the schema contract for one string-valued management-tool input. */
const stringInput = (name: string, required = false): ManagementToolInput => ({
  name,
  required,
  schema: { type: "string" }
});

const readOnlyLocal: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const localMutation: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};

const MANAGEMENT_TOOL_DESCRIPTORS_INTERNAL: readonly ManagementToolDescriptor[] = [
  {
    name: "miftah_list_profiles",
    description: "List configured profiles and bounded account-binding state without exposing secrets.",
    inputs: [],
    interaction: "observational",
    availability: "always",
    askInClaudeCode: false,
    annotations: readOnlyLocal
  },
  {
    name: "miftah_current_profile",
    description: "Show the active and default profile.",
    inputs: [],
    interaction: "observational",
    availability: "always",
    askInClaudeCode: false,
    annotations: readOnlyLocal
  },
  {
    name: "miftah_use_profile",
    description: "Switch the active profile according to the configured state scope.",
    inputs: [stringInput("profile", true)],
    interaction: "state-changing",
    availability: "always",
    askInClaudeCode: true,
    annotations: localMutation
  },
  {
    name: "miftah_reset_profile",
    description: "Reset the active profile to the configured default.",
    inputs: [],
    interaction: "state-changing",
    availability: "always",
    askInClaudeCode: true,
    annotations: localMutation
  },
  {
    name: "miftah_lock_profile",
    description: "Lock the current profile for this MCP connection when enabled.",
    inputs: [],
    interaction: "state-changing",
    availability: "always",
    askInClaudeCode: true,
    annotations: localMutation
  },
  {
    name: "miftah_unlock_profile",
    description: "Unlock the current profile for this MCP connection when enabled.",
    inputs: [],
    interaction: "state-changing",
    availability: "always",
    askInClaudeCode: true,
    annotations: { ...localMutation, idempotentHint: true }
  },
  {
    name: "miftah_profile_info",
    description: "Show non-secret metadata and bounded account-binding state for a profile.",
    inputs: [stringInput("profile", true)],
    interaction: "observational",
    availability: "always",
    askInClaudeCode: false,
    annotations: readOnlyLocal
  },
  {
    name: "miftah_health",
    description: "Show redacted wrapper and upstream health.",
    inputs: [],
    interaction: "observational",
    availability: "always",
    askInClaudeCode: false,
    annotations: readOnlyLocal
  },
  {
    name: "miftah_validate_config",
    description: "Validate the loaded wrapper configuration.",
    inputs: [],
    interaction: "observational",
    availability: "always",
    askInClaudeCode: false,
    annotations: readOnlyLocal
  },
  {
    name: "miftah_list_upstream_tools",
    description: "List tools discovered from an upstream profile.",
    inputs: [stringInput("profile")],
    interaction: "external-probe",
    availability: "always",
    askInClaudeCode: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: "miftah_restart_profile",
    description: "Restart all upstream processes for a profile.",
    inputs: [stringInput("profile", true)],
    interaction: "state-changing",
    availability: "always",
    askInClaudeCode: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: "miftah_verify_identity",
    description: "Explicitly verify configured upstream identity.",
    inputs: [stringInput("profile"), stringInput("upstream")],
    interaction: "external-probe",
    availability: "always",
    askInClaudeCode: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: "miftah_route_preview",
    description: "Preview routing for a hypothetical tool call.",
    inputs: [
      stringInput("toolName", true),
      { name: "args", required: false, schema: { type: "object", additionalProperties: true } }
    ],
    interaction: "external-probe",
    availability: "always",
    askInClaudeCode: true,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: "miftah_list_approvals",
    description: "List safe metadata for approvals pending in this connection.",
    inputs: [],
    interaction: "observational",
    availability: "always",
    askInClaudeCode: false,
    annotations: readOnlyLocal
  },
  {
    name: "miftah_approve",
    description: "Approve a pending operation using its one-time approval token.",
    inputs: [stringInput("approval", true)],
    interaction: "state-changing",
    availability: "delegated-agent",
    askInClaudeCode: true,
    annotations: localMutation
  },
  {
    name: "miftah_deny",
    description: "Deny a pending operation using its one-time approval token.",
    inputs: [stringInput("approval", true)],
    interaction: "state-changing",
    availability: "delegated-agent",
    askInClaudeCode: true,
    annotations: { ...localMutation, destructiveHint: true }
  }
];

export const MANAGEMENT_TOOL_DESCRIPTORS = Object.freeze(MANAGEMENT_TOOL_DESCRIPTORS_INTERNAL);
export const MANAGEMENT_TOOL_NAMES = Object.freeze(MANAGEMENT_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name));

/** Returns whether a tool name is reserved by Miftah's management surface. */
export function isManagementToolName(name: string): boolean {
  return MANAGEMENT_TOOL_NAMES.includes(name);
}

/** Returns descriptors visible under the configured delegated-approval mode. */
export function managementToolDescriptors(options: ManagementToolOptions): readonly ManagementToolDescriptor[] {
  return MANAGEMENT_TOOL_DESCRIPTORS.filter(
    (descriptor) => descriptor.availability === "always" || options.delegatedAgentApproval
  );
}

/** Projects the visible descriptor contract into MCP SDK tool definitions. */
export function managementTools(options: ManagementToolOptions): readonly Tool[] {
  return managementToolDescriptors(options).map(toolFromDescriptor);
}

/** Converts one immutable management descriptor into its MCP tool representation. */
function toolFromDescriptor(descriptor: ManagementToolDescriptor): Tool {
  const required = descriptor.inputs.filter((input) => input.required).map((input) => input.name);
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(descriptor.inputs.map((input) => [input.name, input.schema])),
      ...(required.length === 0 ? {} : { required })
    },
    annotations: descriptor.annotations
  };
}
