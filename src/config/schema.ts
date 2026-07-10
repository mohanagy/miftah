import { z } from "zod";

const recordSchema = z.record(z.string(), z.unknown());
const unsupportedOptionSchema = z.unknown().optional();

const configVersionSchema = z.string().superRefine((value, context) => {
  if (value !== "1") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      params: {
        miftahCode: "UNSUPPORTED_CONFIG_VERSION",
        remediation: 'Set version to "1"; automatic config migrations are not supported.'
      },
      message: "UNSUPPORTED_CONFIG_VERSION: only config version '1' is supported"
    });
  }
});

const upstreamBaseShape = {
  transport: z.enum(["stdio", "http", "sse", "streamable-http"]),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional()
};

const upstreamSchema = z.object(upstreamBaseShape).strict().superRefine((value, context) => {
  if (value.transport === "stdio" && !value.command) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: "stdio upstream requires command" });
  }
  if (value.transport !== "stdio" && !value.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "remote upstream requires url" });
  }
});

const publicProfileUpstreamOverrideShape = {
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional()
};

const publicProfileUpstreamOverrideSchema = z.object(publicProfileUpstreamOverrideShape).strict();
const profileUpstreamOverrideSchema = z
  .object({
    ...publicProfileUpstreamOverrideShape,
    transport: unsupportedOptionSchema,
    command: unsupportedOptionSchema,
    url: unsupportedOptionSchema
  })
  .strict();

const publicProfileShape = {
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  policy: z.string().optional(),
  upstreams: z.record(z.string(), publicProfileUpstreamOverrideSchema).optional()
};

const publicProfileSchema = z.object(publicProfileShape).strict();
const profileSchema = z
  .object({
    ...publicProfileShape,
    metadata: unsupportedOptionSchema,
    routing: z.object({ match: unsupportedOptionSchema }).strict().optional(),
    upstreams: z.record(z.string(), profileUpstreamOverrideSchema).optional()
  })
  .strict();

const policySchema = z
  .object({
    allow: z.array(z.enum(["read", "write", "destructive"])).optional(),
    allowRisk: z.array(z.enum(["read", "write", "destructive"])).optional(),
    deny: z.array(z.string()).optional(),
    denyRisk: z.array(z.enum(["read", "write", "destructive"])).optional(),
    requireConfirmation: z.array(z.string()).optional()
  })
  .strict();

const routingRuleSchema = z
  .object({
    name: z.string().optional(),
    when: recordSchema,
    profile: z.string().min(1)
  })
  .strict();

const publicRoutingSchema = z
  .object({
    mode: z.literal("hybrid").optional(),
    fallback: z.enum(["default", "activeProfile", "ask", "block"]).optional(),
    rules: z.array(routingRuleSchema).optional()
  })
  .strict();

const routingSchema = z
  .object({
    mode: unsupportedOptionSchema,
    fallback: z.enum(["default", "activeProfile", "ask", "block"]).optional(),
    rules: z.array(routingRuleSchema).optional(),
    plugins: unsupportedOptionSchema
  })
  .strict();

const publicSecuritySchema = z
  .object({
    allowPlaintextSecrets: z.boolean().optional(),
    redactSecrets: z.literal(true).optional(),
    allowProfileSwitchingFromMcp: z.boolean().optional(),
    requireExplicitProfileForDestructive: z.boolean().optional(),
    lockToProfile: z.string().nullable().optional()
  })
  .strict();

const securitySchema = z
  .object({
    allowPlaintextSecrets: z.boolean().optional(),
    redactSecrets: z.boolean().optional(),
    allowProfileSwitchingFromMcp: z.boolean().optional(),
    requireProfileSwitchConfirmation: unsupportedOptionSchema,
    requireExplicitProfileForDestructive: z.boolean().optional(),
    lockToProfile: z.string().nullable().optional()
  })
  .strict();

const publicProcessSchema = z.object({ startupTimeoutMs: z.number().int().positive().optional() }).strict();
const processSchema = z
  .object({
    startMode: unsupportedOptionSchema,
    cache: unsupportedOptionSchema,
    idleTimeoutMs: unsupportedOptionSchema,
    restartOnCrash: unsupportedOptionSchema,
    maxRestarts: unsupportedOptionSchema,
    startupTimeoutMs: z.number().int().positive().optional(),
    shutdownTimeoutMs: unsupportedOptionSchema,
    maxConcurrentProfiles: unsupportedOptionSchema
  })
  .strict();

const publicAuditSchema = z
  .object({
    enabled: z.boolean().optional(),
    path: z.string().optional(),
    format: z.literal("jsonl").optional(),
    includeArguments: z.boolean().optional(),
    redact: z.literal(true).optional()
  })
  .strict();

const auditSchema = z
  .object({
    enabled: z.boolean().optional(),
    path: z.string().optional(),
    format: z.literal("jsonl").optional(),
    includeArguments: z.boolean().optional(),
    redact: z.boolean().optional()
  })
  .strict();

const publicToolingSchema = z
  .object({
    collisionStrategy: z.enum(["prefix-upstream", "fail"]).optional(),
    toolRiskOverrides: z.record(z.string(), z.enum(["read", "write", "destructive"])).optional()
  })
  .strict();

const toolingSchema = z
  .object({
    managementToolPrefix: unsupportedOptionSchema,
    upstreamToolNamespace: unsupportedOptionSchema,
    collisionStrategy: z.enum(["prefix-upstream", "fail"]).optional(),
    toolDiscoveryMode: unsupportedOptionSchema,
    toolRiskOverrides: z.record(z.string(), z.enum(["read", "write", "destructive"])).optional()
  })
  .strict();

const secretsSchema = z
  .object({
    envFiles: z.array(z.string()).optional(),
    allowPlaintextSecrets: z.boolean().optional()
  })
  .strict();

const stateSchema = z
  .object({
    persistActiveProfile: unsupportedOptionSchema,
    path: unsupportedOptionSchema
  })
  .strict();

type ConfigReferenceInput = {
  defaultProfile: string;
  upstream?: unknown;
  upstreams?: Record<string, unknown>;
  profiles: Record<string, { policy?: string; upstreams?: Record<string, unknown> }>;
  routing?: { rules?: { profile: string }[] };
  policies?: Record<string, unknown>;
  security?: { lockToProfile?: string | null };
};

type ConfigIssueCode =
  | "CONFIG_SCHEMA_INVALID"
  | "DEFAULT_PROFILE_NOT_FOUND"
  | "POLICY_NOT_FOUND"
  | "ROUTING_PROFILE_NOT_FOUND"
  | "LOCK_PROFILE_NOT_FOUND"
  | "UPSTREAM_NOT_FOUND"
  | "UNSUPPORTED_CONFIG_OPTION";

function addConfigIssue(
  context: z.RefinementCtx,
  code: ConfigIssueCode,
  path: (string | number)[],
  explanation: string,
  remediation: string
): void {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    params: { miftahCode: code, remediation },
    message: `${code}: ${explanation}`
  });
}

function validateConfigReferences(value: ConfigReferenceInput, context: z.RefinementCtx): void {
  if (!value.upstream && !value.upstreams) {
    addConfigIssue(
      context,
      "CONFIG_SCHEMA_INVALID",
      ["upstream"],
      "config requires upstream or upstreams",
      "Configure either `upstream` or `upstreams`."
    );
  }
  if (value.upstream && value.upstreams) {
    addConfigIssue(
      context,
      "CONFIG_SCHEMA_INVALID",
      ["upstream"],
      "choose upstream or upstreams, not both",
      "Configure either `upstream` or `upstreams`, not both."
    );
  }

  const profileNames = new Set(Object.keys(value.profiles));
  const policyNames = new Set(Object.keys(value.policies ?? {}));
  const upstreamNames = new Set(Object.keys(value.upstreams ?? {}));
  if (!profileNames.has(value.defaultProfile)) {
    addConfigIssue(
      context,
      "DEFAULT_PROFILE_NOT_FOUND",
      ["defaultProfile"],
      `profile '${value.defaultProfile}' does not exist`,
      "Choose a profile name defined under `profiles`."
    );
  }

  for (const [profileName, profile] of Object.entries(value.profiles)) {
    if (profile.policy !== undefined && !policyNames.has(profile.policy)) {
      addConfigIssue(
        context,
        "POLICY_NOT_FOUND",
        ["profiles", profileName, "policy"],
        `policy '${profile.policy}' does not exist`,
        "Choose a policy name defined under `policies`."
      );
    }
    for (const upstreamName of Object.keys(profile.upstreams ?? {})) {
      if (!upstreamNames.has(upstreamName)) {
        addConfigIssue(
          context,
          "UPSTREAM_NOT_FOUND",
          ["profiles", profileName, "upstreams", upstreamName],
          `upstream '${upstreamName}' does not exist`,
          "Choose an upstream name defined under `upstreams` or remove the override."
        );
      }
    }
  }

  for (const [ruleIndex, rule] of (value.routing?.rules ?? []).entries()) {
    if (!profileNames.has(rule.profile)) {
      addConfigIssue(
        context,
        "ROUTING_PROFILE_NOT_FOUND",
        ["routing", "rules", ruleIndex, "profile"],
        `profile '${rule.profile}' does not exist`,
        "Choose a profile name defined under `profiles`."
      );
    }
  }

  if (value.security?.lockToProfile !== undefined && value.security.lockToProfile !== null) {
    if (!profileNames.has(value.security.lockToProfile)) {
      addConfigIssue(
        context,
        "LOCK_PROFILE_NOT_FOUND",
        ["security", "lockToProfile"],
        `profile '${value.security.lockToProfile}' does not exist`,
        "Choose a profile name defined under `profiles`."
      );
    }
  }
}

/** The strict, supported configuration surface used for runtime output and JSON Schema generation. */
export const miftahPublicConfigSchema = z
  .object({
    version: z.literal("1"),
    name: z.string().min(1),
    description: z.string().optional(),
    defaultProfile: z.string().min(1),
    upstream: upstreamSchema.optional(),
    upstreams: z.record(z.string(), upstreamSchema).optional(),
    profiles: z.record(z.string(), publicProfileSchema),
    routing: publicRoutingSchema.optional(),
    policies: z.record(z.string(), policySchema).optional(),
    security: publicSecuritySchema.optional(),
    process: publicProcessSchema.optional(),
    audit: publicAuditSchema.optional(),
    tooling: publicToolingSchema.optional(),
    secrets: secretsSchema.optional()
  })
  .strict()
  .superRefine(validateConfigReferences);

/** Zod schema for validating accepted compatibility declarations before normalizing to the public contract. */
export const miftahConfigSchema = z
  .object({
    version: configVersionSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    defaultProfile: z.string().min(1),
    upstream: upstreamSchema.optional(),
    upstreams: z.record(z.string(), upstreamSchema).optional(),
    profiles: z.record(z.string(), profileSchema),
    routing: routingSchema.optional(),
    policies: z.record(z.string(), policySchema).optional(),
    security: securitySchema.optional(),
    process: processSchema.optional(),
    audit: auditSchema.optional(),
    tooling: toolingSchema.optional(),
    secrets: secretsSchema.optional(),
    state: stateSchema.optional(),
    ui: unsupportedOptionSchema
  })
  .strict()
  .superRefine((value, context) => {
    validateConfigReferences(value, context);

    const rejectUnsupportedOption = (path: (string | number)[], explanation: string): void => {
      addConfigIssue(
        context,
        "UNSUPPORTED_CONFIG_OPTION",
        path,
        explanation,
        "Remove this option or use a supported alternative from `miftah schema`."
      );
    };

    for (const [profileName, profile] of Object.entries(value.profiles)) {
      if (profile.metadata !== undefined) {
        rejectUnsupportedOption(
          ["profiles", profileName, "metadata"],
          "profile metadata has no runtime consumer; remove it or store it outside the Miftah config"
        );
      }
      if (profile.routing?.match !== undefined) {
        rejectUnsupportedOption(
          ["profiles", profileName, "routing", "match"],
          "profile routing matchers are not implemented; use routing.rules instead"
        );
      }
      for (const [upstreamName, override] of Object.entries(profile.upstreams ?? {})) {
        for (const option of ["transport", "command", "url"] as const) {
          if (override[option] !== undefined) {
            rejectUnsupportedOption(
              ["profiles", profileName, "upstreams", upstreamName, option],
              `per-profile upstream '${option}' overrides are not implemented; only args, env, cwd, and headers may vary by profile`
            );
          }
        }
      }
    }

    if (value.routing?.mode !== undefined && value.routing.mode !== "hybrid") {
      rejectUnsupportedOption(
        ["routing", "mode"],
        "only the existing hybrid routing behavior is supported; active and rules modes are not implemented"
      );
    }
    if (value.routing?.plugins !== undefined) {
      rejectUnsupportedOption(["routing", "plugins"], "routing plugins are not implemented");
    }

    for (const option of [
      "startMode",
      "cache",
      "idleTimeoutMs",
      "restartOnCrash",
      "maxRestarts",
      "shutdownTimeoutMs",
      "maxConcurrentProfiles"
    ] as const) {
      if (value.process?.[option] !== undefined) {
        rejectUnsupportedOption(
          ["process", option],
          `${option} is not implemented; only process.startupTimeoutMs currently changes runtime behavior`
        );
      }
    }

    if (value.security?.requireProfileSwitchConfirmation !== undefined) {
      rejectUnsupportedOption(
        ["security", "requireProfileSwitchConfirmation"],
        "profile switch confirmation is not implemented; use allowProfileSwitchingFromMcp or lockToProfile"
      );
    }
    if (value.security?.redactSecrets === false) {
      rejectUnsupportedOption(["security", "redactSecrets"], "secret redaction is always enabled and cannot be disabled");
    }

    if (value.audit?.redact === false) {
      rejectUnsupportedOption(["audit", "redact"], "audit redaction is always enabled and cannot be disabled");
    }

    for (const option of ["managementToolPrefix", "upstreamToolNamespace", "toolDiscoveryMode"] as const) {
      if (value.tooling?.[option] !== undefined) {
        rejectUnsupportedOption(["tooling", option], `${option} is not implemented`);
      }
    }

    for (const option of ["persistActiveProfile", "path"] as const) {
      if (value.state?.[option] !== undefined) {
        rejectUnsupportedOption(["state", option], "persistent profile state is not implemented");
      }
    }
    if (value.ui !== undefined) {
      rejectUnsupportedOption(["ui"], "a Miftah UI is not implemented");
    }
  });

/** Input accepted by {@link miftahConfigSchema} before validation. */
export type MiftahConfigInput = z.input<typeof miftahConfigSchema>;
