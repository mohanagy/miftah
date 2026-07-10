import { z } from "zod";

const recordSchema = z.record(z.string(), z.unknown());

const upstreamBaseSchema = z.object({
  transport: z.enum(["stdio", "http", "sse", "streamable-http"]),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional()
});

const upstreamSchema = upstreamBaseSchema
  .superRefine((value, context) => {
    if (value.transport === "stdio" && !value.command) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: "stdio upstream requires command" });
    }
    if (value.transport !== "stdio" && !value.url) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "remote upstream requires url" });
    }
  });

const profileSchema = z.object({
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  metadata: recordSchema.optional(),
  policy: z.string().optional(),
  routing: z.object({ match: recordSchema.optional() }).optional(),
  upstreams: z.record(z.string(), upstreamBaseSchema.partial()).optional()
});

const policySchema = z.object({
  allow: z.array(z.enum(["read", "write", "destructive"])).optional(),
  allowRisk: z.array(z.enum(["read", "write", "destructive"])).optional(),
  deny: z.array(z.string()).optional(),
  denyRisk: z.array(z.enum(["read", "write", "destructive"])).optional(),
  requireConfirmation: z.array(z.string()).optional()
});

/** Zod schema for validating the complete Miftah configuration format. */
export const miftahConfigSchema = z
  .object({
    version: z.literal("1"),
    name: z.string().min(1),
    description: z.string().optional(),
    defaultProfile: z.string().min(1),
    upstream: upstreamSchema.optional(),
    upstreams: z.record(z.string(), upstreamSchema).optional(),
    profiles: z.record(z.string(), profileSchema),
    routing: z
      .object({
        mode: z.enum(["active", "rules", "hybrid"]).optional(),
        fallback: z.enum(["default", "activeProfile", "ask", "block"]).optional(),
        rules: z
          .array(z.object({ name: z.string().optional(), when: recordSchema, profile: z.string().min(1) }))
          .optional(),
        plugins: z.array(z.string()).optional()
      })
      .optional(),
    policies: z.record(z.string(), policySchema).optional(),
    security: z
      .object({
        allowPlaintextSecrets: z.boolean().optional(),
        redactSecrets: z.boolean().optional(),
        allowProfileSwitchingFromMcp: z.boolean().optional(),
        requireProfileSwitchConfirmation: z.boolean().optional(),
        requireExplicitProfileForDestructive: z.boolean().optional(),
        lockToProfile: z.string().nullable().optional()
      })
      .optional(),
    process: z
      .object({
        startMode: z.enum(["lazy", "eager"]).optional(),
        cache: z.boolean().optional(),
        idleTimeoutMs: z.number().int().nonnegative().optional(),
        restartOnCrash: z.boolean().optional(),
        maxRestarts: z.number().int().nonnegative().optional(),
        startupTimeoutMs: z.number().int().positive().optional(),
        shutdownTimeoutMs: z.number().int().positive().optional(),
        maxConcurrentProfiles: z.number().int().positive().optional()
      })
      .optional(),
    audit: z
      .object({
        enabled: z.boolean().optional(),
        path: z.string().optional(),
        format: z.literal("jsonl").optional(),
        includeArguments: z.boolean().optional(),
        redact: z.boolean().optional()
      })
      .optional(),
    tooling: z
      .object({
        managementToolPrefix: z.string().optional(),
        upstreamToolNamespace: z.enum(["none", "wrapperName", "profile", "both", "upstreamName"]).optional(),
        collisionStrategy: z.enum(["prefix-upstream", "fail"]).optional(),
        toolDiscoveryMode: z
          .enum(["defaultProfile", "allProfilesStrict", "allProfilesUnion", "allProfilesIntersection"])
          .optional(),
        toolRiskOverrides: z.record(z.string(), z.enum(["read", "write", "destructive"])).optional()
      })
      .optional(),
    secrets: z.object({ envFiles: z.array(z.string()).optional(), allowPlaintextSecrets: z.boolean().optional() }).optional(),
    state: z.object({ persistActiveProfile: z.boolean().optional(), path: z.string().optional() }).optional(),
    ui: recordSchema.optional()
  })
  .superRefine((value, context) => {
    if (!value.upstream && !value.upstreams) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["upstream"], message: "config requires upstream or upstreams" });
    }
    if (value.upstream && value.upstreams) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["upstream"], message: "choose upstream or upstreams, not both" });
    }
    if (!value.profiles[value.defaultProfile]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultProfile"],
        params: { miftahCode: "DEFAULT_PROFILE_NOT_FOUND" },
        message: `DEFAULT_PROFILE_NOT_FOUND: profile '${value.defaultProfile}' does not exist`
      });
    }
    const policyNames = new Set(Object.keys(value.policies ?? {}));
    for (const [profileName, profile] of Object.entries(value.profiles)) {
      if (profile.policy !== undefined && !policyNames.has(profile.policy)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", profileName, "policy"],
          params: { miftahCode: "POLICY_NOT_FOUND" },
          message: `POLICY_NOT_FOUND: policy '${profile.policy}' does not exist`
        });
      }
    }
  });

/** Input accepted by {@link miftahConfigSchema} before validation. */
export type MiftahConfigInput = z.input<typeof miftahConfigSchema>;
