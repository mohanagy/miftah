import { isIP } from "node:net";
import { z } from "zod";
import { canonicalizeOAuthResource } from "../oauth/canonical-resource.js";
import { parseOAuthConnectionRef, validateOAuthIssuer } from "../oauth/connection-types.js";
import { hasMergedHeader } from "../upstream/headers.js";
import { SUPPORTED_CONFIG_VERSIONS } from "./versions.js";

const recordSchema = z.record(z.string(), z.unknown());
const unsupportedOptionSchema = z.unknown().optional();
const supportedConfigVersionList = SUPPORTED_CONFIG_VERSIONS.map((version) => `'${version}'`).join(" and ");

const configVersionSchema = z.string().superRefine((value, context) => {
  if (!SUPPORTED_CONFIG_VERSIONS.includes(value as (typeof SUPPORTED_CONFIG_VERSIONS)[number])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      params: {
        miftahCode: "UNSUPPORTED_CONFIG_VERSION",
        remediation: "Use a supported Miftah release, or run `miftah migrate-config --config <file>` for a supported legacy configuration."
      },
      message: `UNSUPPORTED_CONFIG_VERSION: this Miftah release supports config versions ${supportedConfigVersionList}`
    });
  }
});

function hasWhitespaceOrControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code === undefined || code <= 0x20 || code === 0x7f;
  });
}

function isExactOAuthIssuer(value: string): boolean {
  try {
    validateOAuthIssuer(value);
    return true;
  } catch {
    return false;
  }
}

function isCanonicalOAuthResource(value: string): boolean {
  try {
    return canonicalizeOAuthResource(value) === value;
  } catch {
    return false;
  }
}

const oauthConnectionReferenceSchema = z.string().superRefine((value, context) => {
  try {
    parseOAuthConnectionRef(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "OAuth connection references must be opaque generated identifiers" });
  }
});
const oauthTargetIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && !hasWhitespaceOrControl(value), {
    message: "OAuth identifiers must not contain whitespace or control characters"
  });
const oauthClientRegistrationSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value && !hasWhitespaceOrControl(value), {
    message: "OAuth identifiers must not contain whitespace or control characters"
  });
const oauthScopeSchema = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/u);
const oauthConnectionSchema = z
  .object({
    profile: oauthTargetIdentifierSchema,
    upstream: oauthTargetIdentifierSchema,
    resource: z.string().min(1).max(2_048).refine(isCanonicalOAuthResource, {
      message: "OAuth resource must be an exact canonical HTTPS endpoint"
    }),
    issuer: z.string().min(1).max(2_048).refine(isExactOAuthIssuer, {
      message: "OAuth issuer must be an exact HTTPS issuer identifier"
    }),
    clientRegistration: oauthClientRegistrationSchema,
    scopes: z.array(oauthScopeSchema).max(64)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.scopes).size !== value.scopes.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["scopes"], message: "OAuth scopes must be unique" });
    }
  });
const oauthConfigSchema = z
  .object({ connections: z.record(oauthConnectionReferenceSchema, oauthConnectionSchema) })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.connections).length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["connections"], message: "OAuth requires at least one connection" });
    }
  });

const upstreamBaseShape = {
  transport: z.enum(["stdio", "http", "sse", "streamable-http"]),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  trustToolAnnotations: z.boolean().optional()
};

const upstreamSchema = z.object(upstreamBaseShape).strict().superRefine((value, context) => {
  if (value.transport === "stdio" && !value.command) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: "stdio upstream requires command" });
  }
  if (value.transport !== "stdio" && !value.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "remote upstream requires url" });
  }
  if (value.transport !== "stdio" && value.url) {
    const url = new URL(value.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        params: {
          miftahCode: "CONFIG_SCHEMA_INVALID",
          remediation: "Use an https URL, or http only for a loopback development endpoint."
        },
        message: "CONFIG_SCHEMA_INVALID: remote upstream URL must use https unless it targets loopback"
      });
    }
  }
});

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

const identityFieldSchema = z.string().trim().min(1).max(256);
const identityFingerprintSchema = z
  .object({
    provider: identityFieldSchema.optional(),
    login: identityFieldSchema.optional(),
    organization: identityFieldSchema.optional(),
    host: identityFieldSchema.optional()
  })
  .strict();
const identityProbeSchema = z
  .object({
    tool: z.string().trim().min(1).max(256),
    resultFormat: z.enum(["text", "json"]),
    provider: identityFieldSchema.optional()
  })
  .strict();
const identitySchema = z
  .object({
    expected: identityFingerprintSchema,
    probe: identityProbeSchema,
    maxAgeMs: z.number().int().positive().max(86_400_000),
    requiredForRisk: z.array(z.enum(["write", "destructive"])).nonempty().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.expected).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected"],
        message: "identity expected fingerprint must include at least one field"
      });
    }
    if (
      value.requiredForRisk !== undefined &&
      new Set(value.requiredForRisk).size !== value.requiredForRisk.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredForRisk"],
        message: "identity requiredForRisk entries must be unique"
      });
    }
    if (value.probe.resultFormat === "json") {
      if (value.probe.provider !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["probe", "provider"],
          message: "JSON identity probes must derive provider from the response"
        });
      }
      return;
    }

    if (value.expected.login === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected", "login"],
        message: "text identity probes require expected.login"
      });
    }
    for (const field of ["organization", "host"] as const) {
      if (value.expected[field] !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expected", field],
          message: `text identity probes cannot verify '${field}'`
        });
      }
    }
    if (value.expected.provider !== undefined && value.probe.provider !== value.expected.provider) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["probe", "provider"],
        message: "text identity probes require probe.provider to match expected.provider"
      });
    }
  });

const profileLeaseSchema = z
  .object({
    ttlMs: z.number().int().min(1_000).max(3_600_000),
    requiredForRisk: z.array(z.enum(["write", "destructive"])).nonempty().max(2)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.requiredForRisk).size !== value.requiredForRisk.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredForRisk"],
        message: "profile lease requiredForRisk entries must be unique"
      });
    }
  });

const isolationEnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
const generatedIsolationEnvironmentNames = new Set([
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR"
]);

const runtimeRelativePathPattern = new RegExp(
  String.raw`^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])(?:\.{1,2})(?:[\\/]|$))[^\\/\u0000]+(?:[\\/][^\\/\u0000]+)*$`,
  "u"
);
const containerRuntimeRelativePathPattern = new RegExp(
  String.raw`^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])(?:\.{1,2})(?:[\\/]|$))[^\\/,\u0000]+(?:[\\/][^\\/,\u0000]+)*$`,
  "u"
);
const containerDestinationPathPattern = new RegExp(
  String.raw`^\/(?!.*(?:^|\/)(?:\.{1,2})(?:\/|$))[^\\/,\u0000]+(?:\/[^\\/,\u0000]+)*$`,
  "u"
);

const runtimeRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(runtimeRelativePathPattern, "isolation paths must be non-empty relative paths without traversal");

const containerRuntimeRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    containerRuntimeRelativePathPattern,
    "container isolation source paths must be relative, traversal-free, and safe for Docker mount grammar"
  );

const containerDestinationPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(containerDestinationPathPattern, "container isolation destinations must be normalized absolute POSIX paths");

const profileIsolationFileSchema = z
  .object({
    source: runtimeRelativePathSchema,
    destination: runtimeRelativePathSchema,
    environment: isolationEnvironmentNameSchema.optional()
  })
  .strict();

const profileIsolationContainerVolumeSchema = z
  .object({
    source: containerRuntimeRelativePathSchema,
    destination: containerDestinationPathSchema,
    readOnly: z.boolean().optional(),
    environment: isolationEnvironmentNameSchema.optional()
  })
  .strict();

const profileIsolationSchema = z
  .object({
    files: z.array(profileIsolationFileSchema).max(32).optional(),
    containerVolumes: z.array(profileIsolationContainerVolumeSchema).max(32).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const unique = (
      values: readonly { readonly [key: string]: unknown }[],
      property: "destination" | "environment",
      path: "files" | "containerVolumes"
    ): void => {
      const seen = new Set<string>();
      for (const [index, item] of values.entries()) {
        const candidate = item[property];
        if (typeof candidate !== "string") continue;
        const normalizedCandidate = property === "environment" ? candidate.toUpperCase() : candidate;
        if (seen.has(normalizedCandidate)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path, index, property],
            message: `isolation ${path} ${property} entries must be unique`
          });
        }
        seen.add(normalizedCandidate);
      }
    };

    unique(value.files ?? [], "destination", "files");
    unique(value.files ?? [], "environment", "files");
    unique(value.containerVolumes ?? [], "destination", "containerVolumes");
    unique(value.containerVolumes ?? [], "environment", "containerVolumes");

    const rejectGeneratedEnvironmentName = (
      values: readonly { readonly environment?: unknown }[],
      path: "files" | "containerVolumes"
    ): void => {
      for (const [index, item] of values.entries()) {
        if (
          typeof item.environment === "string" &&
          generatedIsolationEnvironmentNames.has(item.environment.toUpperCase())
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path, index, "environment"],
            message: "isolation mappings cannot replace generated HOME, XDG, or platform runtime bindings"
          });
        }
      }
    };

    rejectGeneratedEnvironmentName(value.files ?? [], "files");
    rejectGeneratedEnvironmentName(value.containerVolumes ?? [], "containerVolumes");

    const fileDestinationsByEnvironment = new Map<string, string>();
    for (const file of value.files ?? []) {
      if (file.environment !== undefined) {
        fileDestinationsByEnvironment.set(file.environment.toUpperCase(), file.destination);
      }
    }
    for (const [index, volume] of (value.containerVolumes ?? []).entries()) {
      if (volume.environment === undefined) continue;
      const mappedFileDestination = fileDestinationsByEnvironment.get(volume.environment.toUpperCase());
      if (mappedFileDestination !== undefined && mappedFileDestination !== volume.source) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["containerVolumes", index, "environment"],
          message: "a shared isolation environment binding must mount the matching copied file"
        });
      }
    }
  });

const githubOrganizationSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})$/u);
const githubRepositorySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/u);
const sentrySlugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/u);
const sentryProjectSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}\/[a-z0-9][a-z0-9_-]{0,127}$/u);
const sentryEnvironmentSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const jiraProjectSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,9}$/u);
const linearSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u);
const posthogProjectSchema = z.string().regex(/^[1-9][0-9]{0,17}$/u);
/** Shared with JSON Schema generation so editor validation enforces the same safe origin grammar. */
export const CANONICAL_HTTPS_ORIGIN_PATTERN =
  /^https:\/\/(?!.*:443$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$/u;
const canonicalHttpsOriginSchema = z.string().max(256).regex(CANONICAL_HTTPS_ORIGIN_PATTERN).superRefine((value, context) => {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      value !== `https://${parsed.host}`
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "matcher hosts must be canonical credential-free HTTPS origins" });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "matcher hosts must be canonical credential-free HTTPS origins" });
  }
});

function matcherIdentifierListSchema<T extends z.ZodTypeAny>(item: T) {
  return z.array(item).min(1).max(32).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "matcher identifiers must be unique" });
      }
      seen.add(value);
    }
  });
}

function requireMatcherIdentifiers(value: object, context: z.RefinementCtx, message: string): void {
  if (Object.values(value).every((entry) => entry === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message });
  }
}

const githubProfileRoutingMatchSchema = z
  .object({
    repositories: matcherIdentifierListSchema(githubRepositorySchema).optional(),
    organizations: matcherIdentifierListSchema(githubOrganizationSchema).optional()
  })
  .strict()
  .superRefine((value, context) => requireMatcherIdentifiers(value, context, "GitHub matcher declarations require an identifier"));
const sentryProfileRoutingMatchSchema = z
  .object({
    organizations: matcherIdentifierListSchema(sentrySlugSchema).optional(),
    projects: matcherIdentifierListSchema(sentryProjectSchema).optional(),
    environments: matcherIdentifierListSchema(sentryEnvironmentSchema).optional()
  })
  .strict()
  .superRefine((value, context) => requireMatcherIdentifiers(value, context, "Sentry matcher declarations require an identifier"));
const jiraProfileRoutingMatchSchema = z
  .object({
    sites: matcherIdentifierListSchema(canonicalHttpsOriginSchema).optional(),
    projects: matcherIdentifierListSchema(jiraProjectSchema).optional()
  })
  .strict()
  .superRefine((value, context) => requireMatcherIdentifiers(value, context, "Jira matcher declarations require an identifier"));
const linearProfileRoutingMatchSchema = z
  .object({
    workspaces: matcherIdentifierListSchema(linearSlugSchema).optional(),
    teams: matcherIdentifierListSchema(linearSlugSchema).optional()
  })
  .strict()
  .superRefine((value, context) => requireMatcherIdentifiers(value, context, "Linear matcher declarations require an identifier"));
const posthogProfileRoutingMatchSchema = z
  .object({
    hosts: matcherIdentifierListSchema(canonicalHttpsOriginSchema).optional(),
    projects: matcherIdentifierListSchema(posthogProjectSchema).optional()
  })
  .strict()
  .superRefine((value, context) => requireMatcherIdentifiers(value, context, "PostHog matcher declarations require an identifier"));
const profileRoutingMatchSchema = z
  .object({
    github: githubProfileRoutingMatchSchema.optional(),
    sentry: sentryProfileRoutingMatchSchema.optional(),
    jira: jiraProfileRoutingMatchSchema.optional(),
    linear: linearProfileRoutingMatchSchema.optional(),
    posthog: posthogProfileRoutingMatchSchema.optional()
  })
  .strict()
  .superRefine((value, context) => requireMatcherIdentifiers(value, context, "profile routing matches require a provider"));
const profileRoutingSchema = z.object({ match: profileRoutingMatchSchema }).strict();

const publicProfileUpstreamOverrideShape = {
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  identity: identitySchema.optional(),
  isolation: profileIsolationSchema.optional()
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
  identity: identitySchema.optional(),
  lease: profileLeaseSchema.optional(),
  isolation: profileIsolationSchema.optional(),
  routing: profileRoutingSchema.optional(),
  upstreams: z.record(z.string(), publicProfileUpstreamOverrideSchema).optional()
};

const publicProfileSchema = z.object(publicProfileShape).strict();
const profileSchema = z
  .object({
    ...publicProfileShape,
    metadata: unsupportedOptionSchema,
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
    requireProfileSwitchConfirmation: z.boolean().optional(),
    approvalMode: z.enum(["human", "delegated-agent"]).optional(),
    allowProfileLockingFromMcp: z.boolean().optional(),
    requireExplicitProfileForDestructive: z.boolean().optional(),
    requireExplicitSelectionForDestructive: z.boolean().optional(),
    lockToProfile: z.string().nullable().optional()
  })
  .strict();

const securitySchema = z
  .object({
    allowPlaintextSecrets: z.boolean().optional(),
    redactSecrets: z.boolean().optional(),
    allowProfileSwitchingFromMcp: z.boolean().optional(),
    requireProfileSwitchConfirmation: z.boolean().optional(),
    approvalMode: z.enum(["human", "delegated-agent"]).optional(),
    allowProfileLockingFromMcp: z.boolean().optional(),
    requireExplicitProfileForDestructive: z.boolean().optional(),
    requireExplicitSelectionForDestructive: z.boolean().optional(),
    lockToProfile: z.string().nullable().optional()
  })
  .strict();

const publicProcessSchema = z
  .object({
    startupTimeoutMs: z.number().int().positive().optional(),
    shutdownTimeoutMs: z.number().int().positive().optional(),
    idleTimeoutMs: z.number().int().positive().optional(),
    restartOnCrash: z.boolean().optional(),
    maxRestarts: z.number().int().nonnegative().optional(),
    maxConcurrentProfiles: z.number().int().positive().optional()
  })
  .strict();
const processSchema = z
  .object({
    startMode: unsupportedOptionSchema,
    cache: unsupportedOptionSchema,
    startupTimeoutMs: z.number().int().positive().optional(),
    shutdownTimeoutMs: z.number().int().positive().optional(),
    idleTimeoutMs: z.number().int().positive().optional(),
    restartOnCrash: z.boolean().optional(),
    maxRestarts: z.number().int().nonnegative().optional(),
    maxConcurrentProfiles: z.number().int().positive().optional()
  })
  .strict();

const auditRotationSchema = z
  .object({
    maxBytes: z.number().int().positive().max(2_147_483_647).optional(),
    maxAgeMs: z.number().int().positive().max(31_536_000_000).optional(),
    retainFiles: z.number().int().min(0).max(2_000)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maxBytes === undefined && value.maxAgeMs === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "audit rotation requires maxBytes or maxAgeMs"
      });
    }
  });

const auditIntegritySchema = z
  .object({
    algorithm: z.literal("sha256-chain")
  })
  .strict();

function validateManagedAuditOptions(
  value: {
    enabled?: boolean;
    path?: string;
    rotation?: unknown;
    integrity?: unknown;
  },
  context: z.RefinementCtx
): void {
  if (value.rotation === undefined && value.integrity === undefined) return;

  if (value.path === undefined || value.path.length === 0) {
    addConfigIssue(
      context,
      "CONFIG_SCHEMA_INVALID",
      ["path"],
      "audit.path is required when rotation or integrity is configured",
      "Set audit.path to a non-empty JSONL journal path or remove audit.rotation and audit.integrity."
    );
  }

  if (value.enabled === false) {
    addConfigIssue(
      context,
      "CONFIG_SCHEMA_INVALID",
      ["enabled"],
      "audit.enabled cannot be false when rotation or integrity is configured",
      "Enable audit or remove audit.rotation and audit.integrity."
    );
  }
}

const publicAuditSchema = z
  .object({
    enabled: z.boolean().optional(),
    path: z.string().min(1).optional(),
    format: z.literal("jsonl").optional(),
    includeArguments: z.boolean().optional(),
    redact: z.literal(true).optional(),
    failureMode: z.enum(["fail-open", "fail-closed"]).optional(),
    rotation: auditRotationSchema.optional(),
    integrity: auditIntegritySchema.optional()
  })
  .strict()
  .superRefine(validateManagedAuditOptions);

const auditSchema = z
  .object({
    enabled: z.boolean().optional(),
    path: z.string().min(1).optional(),
    format: z.literal("jsonl").optional(),
    includeArguments: z.boolean().optional(),
    redact: z.boolean().optional(),
    failureMode: z.enum(["fail-open", "fail-closed"]).optional(),
    rotation: auditRotationSchema.optional(),
    integrity: auditIntegritySchema.optional()
  })
  .strict()
  .superRefine(validateManagedAuditOptions);

const publicToolingSchema = z
  .object({
    collisionStrategy: z.enum(["prefix-upstream", "fail"]).optional(),
    toolDiscoveryMode: z.enum(["permissive", "strict"]).optional(),
    toolRiskOverrides: z.record(z.string(), z.enum(["read", "write", "destructive"])).optional(),
    unknownToolRisk: z.enum(["write", "destructive"]).optional()
  })
  .strict();

const toolingSchema = z
  .object({
    managementToolPrefix: unsupportedOptionSchema,
    upstreamToolNamespace: unsupportedOptionSchema,
    collisionStrategy: z.enum(["prefix-upstream", "fail"]).optional(),
    toolDiscoveryMode: z.enum(["permissive", "strict"]).optional(),
    toolRiskOverrides: z.record(z.string(), z.enum(["read", "write", "destructive"])).optional(),
    unknownToolRisk: z.enum(["write", "destructive"]).optional()
  })
  .strict();

const secretsSchema = z
  .object({
    envFiles: z.array(z.string()).optional(),
    allowPlaintextSecrets: z.boolean().optional(),
    providerTimeoutMs: z.number().int().min(100).max(120_000).optional()
  })
  .strict();

const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const localPluginPathSchema = z
  .string()
  .regex(
    /^\.\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/u,
    "Plugin paths must be explicit local .mjs paths below the configuration directory."
  );
const pluginBindingSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const pluginProfileSchema = z.string().min(1).max(256);
const secretProviderPluginSchema = z
  .object({
    id: pluginIdSchema,
    kind: z.literal("secret-provider"),
    path: localPluginPathSchema
  })
  .strict();
const routingMatcherPluginSchema = z
  .object({
    id: pluginIdSchema,
    kind: z.literal("routing-matcher"),
    path: localPluginPathSchema,
    bindings: z.record(pluginBindingSchema, pluginProfileSchema).refine(
      (bindings) => Object.keys(bindings).length > 0 && Object.keys(bindings).length <= 64,
      "Routing matcher plugins require between one and 64 configured bindings."
    )
  })
  .strict();
const pluginConfigSchema = z.discriminatedUnion("kind", [secretProviderPluginSchema, routingMatcherPluginSchema]);
const reservedPluginIds = new Set(["env", "dotenv", "plain", "keychain", "op"]);
const pluginsSchema = z
  .object({
    allowlist: z.array(pluginConfigSchema).min(1).max(32),
    timeoutMs: z.number().int().min(100).max(60_000).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, plugin] of value.allowlist.entries()) {
      if (reservedPluginIds.has(plugin.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowlist", index, "id"],
          params: {
            miftahCode: "CONFIG_SCHEMA_INVALID",
            remediation: "Choose a plugin id other than a built-in secret provider id."
          },
          message: "CONFIG_SCHEMA_INVALID: plugin ids cannot replace built-in secret providers"
        });
      }
      if (ids.has(plugin.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowlist", index, "id"],
          params: { miftahCode: "CONFIG_SCHEMA_INVALID", remediation: "Use a unique plugin id for each allowlist entry." },
          message: "CONFIG_SCHEMA_INVALID: plugin allowlist ids must be unique"
        });
      }
      ids.add(plugin.id);
    }
  });

const activeProfileStateScopeSchema = z.enum(["process", "session", "workspace", "global"]);

const publicStateSchema = z
  .object({
    persistActiveProfile: z.boolean().optional(),
    scope: activeProfileStateScopeSchema.optional()
  })
  .strict()
  .superRefine(validateProfileState);

const stateSchema = z
  .object({
    persistActiveProfile: z.boolean().optional(),
    scope: activeProfileStateScopeSchema.optional(),
    path: unsupportedOptionSchema
  })
  .strict();

const httpHostPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;
const secretReferencePattern = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|secretref:[a-z][a-z0-9+.-]*:.*)$/u;

export function isCanonicalHttpHost(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value !== value.toLowerCase()) return false;
  return httpHostPattern.test(value) || isIP(value) === 6;
}

function isCanonicalHttpOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return (
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.username.length === 0 &&
      origin.password.length === 0 &&
      origin.pathname === "/" &&
      origin.search.length === 0 &&
      origin.hash.length === 0 &&
      origin.origin === value
    );
  } catch {
    return false;
  }
}

export function isLiteralLoopbackBindHost(value: string): boolean {
  return value === "127.0.0.1" || value === "::1";
}

function hasDuplicateEntries(values: readonly string[] | undefined): boolean {
  return values !== undefined && new Set(values).size !== values.length;
}

const httpHostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(isCanonicalHttpHost, "HTTP hosts must be canonical lowercase host names or IP literals.");
const httpOriginSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(isCanonicalHttpOrigin, "HTTP origins must be canonical http or https origins without a path.");
const secretReferenceSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => secretReferencePattern.test(value), "Authentication must use a supported secret reference.");

function validateHttpServerConfig(
  value: {
    readonly host?: string;
    readonly allowNonLoopback?: true;
    readonly authToken?: string;
    readonly allowedHosts?: readonly string[];
    readonly allowedOrigins?: readonly string[];
  },
  context: z.RefinementCtx
): void {
  if (hasDuplicateEntries(value.allowedHosts)) {
    addConfigIssue(
      context,
      "CONFIG_SCHEMA_INVALID",
      ["allowedHosts"],
      "HTTP allowedHosts entries must be unique",
      "Remove duplicate HTTP host entries."
    );
  }
  if (hasDuplicateEntries(value.allowedOrigins)) {
    addConfigIssue(
      context,
      "CONFIG_SCHEMA_INVALID",
      ["allowedOrigins"],
      "HTTP allowedOrigins entries must be unique",
      "Remove duplicate HTTP origin entries."
    );
  }

  const bindHost = value.host ?? "127.0.0.1";
  if (isLiteralLoopbackBindHost(bindHost)) return;

  if (value.allowNonLoopback !== true) {
    addConfigIssue(
      context,
      "CONFIG_SCHEMA_INVALID",
      ["allowNonLoopback"],
      "non-loopback HTTP serving requires explicit opt-in",
      "Set server.http.allowNonLoopback to true only with deliberate network exposure."
    );
  }
  if (value.authToken === undefined) {
    addConfigIssue(
      context,
      "CONFIG_SCHEMA_INVALID",
      ["authToken"],
      "non-loopback HTTP serving requires a secret-backed bearer token",
      "Configure server.http.authToken with a supported secret reference."
    );
  }
  if (value.allowedHosts === undefined || value.allowedHosts.length === 0) {
    addConfigIssue(
      context,
      "CONFIG_SCHEMA_INVALID",
      ["allowedHosts"],
      "non-loopback HTTP serving requires explicit allowed hosts",
      "Configure the exact Host names clients may send."
    );
  }
}

const httpServerSchema = z
  .object({
    host: httpHostSchema.optional(),
    port: z.number().int().min(0).max(65_535).optional(),
    allowNonLoopback: z.literal(true).optional(),
    authToken: secretReferenceSchema.optional(),
    allowedHosts: z.array(httpHostSchema).min(1).max(64).optional(),
    allowedOrigins: z.array(httpOriginSchema).max(64).optional(),
    maxSessions: z.number().int().min(1).max(256).optional(),
    sessionIdleTimeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
    maxRequestBytes: z.number().int().min(1_024).max(10_485_760).optional()
  })
  .strict()
  .superRefine(validateHttpServerConfig);

const serverSchema = z.object({ http: httpServerSchema.optional() }).strict();
const publicServerSchema = z.object({ http: httpServerSchema.optional() }).strict();

type IsolationDestinationInput = {
  destination: string;
  environment?: string;
};

type IsolationContainerVolumeInput = IsolationDestinationInput & {
  source: string;
};

type ProfileIsolationReferenceInput = {
  files?: readonly IsolationDestinationInput[];
  containerVolumes?: readonly IsolationContainerVolumeInput[];
};

type UpstreamTransportReference = {
  transport: "stdio" | "http" | "sse" | "streamable-http";
  url?: string;
  headers?: Record<string, string>;
};

type ConfigReferenceInput = {
  defaultProfile: string;
  upstream?: UpstreamTransportReference;
  upstreams?: Record<string, UpstreamTransportReference>;
  profiles: Record<
    string,
    {
      policy?: string;
      headers?: Record<string, string>;
      isolation?: ProfileIsolationReferenceInput;
      upstreams?: Record<string, { headers?: Record<string, string>; isolation?: ProfileIsolationReferenceInput }>;
    }
  >;
  routing?: { rules?: { profile: string }[] };
  plugins?: {
    allowlist?: readonly { kind: "secret-provider" | "routing-matcher"; bindings?: Record<string, string> }[];
  };
  policies?: Record<string, unknown>;
  security?: { lockToProfile?: string | null };
  oauth?: {
    connections: Record<
      string,
      {
        profile: string;
        upstream: string;
        resource: string;
        issuer: string;
        clientRegistration: string;
        scopes: string[];
      }
    >;
  };
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
  const namedUpstreams = value.upstreams ?? {};
  const upstreamNames = new Set(Object.keys(namedUpstreams));
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
    if (profile.isolation !== undefined) {
      if (value.upstream !== undefined) {
        validateIsolationTransport(
          ["profiles", profileName, "isolation"],
          "the configured upstream",
          value.upstream.transport,
          context
        );
      } else {
        for (const [upstreamName, upstream] of Object.entries(namedUpstreams)) {
          validateIsolationTransport(
            ["profiles", profileName, "isolation"],
            `upstream '${upstreamName}'`,
            upstream.transport,
            context
          );
        }
      }
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
      const override = profile.upstreams?.[upstreamName];
      if (override !== undefined) {
        validateMergedIsolationDestinations(profileName, upstreamName, profile.isolation, override.isolation, context);
        const upstream = namedUpstreams[upstreamName];
        if (upstream !== undefined && override.isolation !== undefined) {
          validateIsolationTransport(
            ["profiles", profileName, "upstreams", upstreamName, "isolation"],
            `upstream '${upstreamName}'`,
            upstream.transport,
            context
          );
        }
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

  for (const [pluginIndex, plugin] of (value.plugins?.allowlist ?? []).entries()) {
    if (plugin.kind !== "routing-matcher") continue;
    for (const [binding, profile] of Object.entries(plugin.bindings ?? {})) {
      if (profileNames.has(profile)) continue;
      addConfigIssue(
        context,
        "ROUTING_PROFILE_NOT_FOUND",
        ["plugins", "allowlist", pluginIndex, "bindings", binding],
        `routing plugin binding '${binding}' targets profile '${profile}', which does not exist`,
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

  validateOAuthConnections(value, context, profileNames, namedUpstreams);
}

function validateOAuthConnections(
  value: ConfigReferenceInput,
  context: z.RefinementCtx,
  profileNames: ReadonlySet<string>,
  namedUpstreams: Readonly<Record<string, UpstreamTransportReference>>
): void {
  for (const [connectionRef, connection] of Object.entries(value.oauth?.connections ?? {})) {
    const path = ["oauth", "connections", connectionRef] as const;
    const profile = value.profiles[connection.profile];
    if (!profileNames.has(connection.profile) || profile === undefined) {
      addConfigIssue(
        context,
        "ROUTING_PROFILE_NOT_FOUND",
        [...path, "profile"],
        "OAuth connection targets a profile that does not exist",
        "Choose a profile defined under profiles."
      );
      continue;
    }

    const singleton = value.upstream;
    const upstream = singleton ?? namedUpstreams[connection.upstream];
    if (singleton !== undefined && connection.upstream !== "default") {
      addConfigIssue(
        context,
        "UPSTREAM_NOT_FOUND",
        [...path, "upstream"],
        "a singleton upstream must be referenced as 'default'",
        "Set oauth.connections.<ref>.upstream to 'default'."
      );
      continue;
    }
    if (singleton === undefined && upstream === undefined) {
      addConfigIssue(
        context,
        "UPSTREAM_NOT_FOUND",
        [...path, "upstream"],
        "OAuth connection targets an upstream that does not exist",
        "Choose an upstream defined under upstreams."
      );
      continue;
    }
    if (upstream === undefined || upstream.transport !== "streamable-http" || upstream.url === undefined) {
      addConfigIssue(
        context,
        "CONFIG_SCHEMA_INVALID",
        [...path, "upstream"],
        "OAuth connections require an HTTPS streamable-http upstream",
        "Configure the selected upstream with transport 'streamable-http' and an HTTPS URL."
      );
      continue;
    }

    let canonicalUpstreamResource: string;
    try {
      canonicalUpstreamResource = canonicalizeOAuthResource(upstream.url);
    } catch {
      addConfigIssue(
        context,
        "CONFIG_SCHEMA_INVALID",
        [...path, "resource"],
        "OAuth requires a canonical HTTPS upstream resource URL",
        "Use the exact canonical HTTPS streamable-http endpoint for both upstream.url and oauth resource."
      );
      continue;
    }
    if (upstream.url !== canonicalUpstreamResource || connection.resource !== canonicalUpstreamResource) {
      addConfigIssue(
        context,
        "CONFIG_SCHEMA_INVALID",
        [...path, "resource"],
        "OAuth resource must exactly match the canonical selected upstream URL",
        "Use the same canonical HTTPS URL for upstream.url and oauth resource."
      );
    }

    const upstreamOverride = singleton === undefined ? profile.upstreams?.[connection.upstream] : undefined;
    if (hasMergedHeader("authorization", upstream.headers, profile.headers, upstreamOverride?.headers)) {
      addConfigIssue(
        context,
        "CONFIG_SCHEMA_INVALID",
        [...path],
        "OAuth connections cannot coexist with an effective Authorization header",
        "Remove the static Authorization header before configuring native OAuth for this profile and upstream."
      );
    }
  }

  const targets = new Set<string>();
  for (const [connectionRef, connection] of Object.entries(value.oauth?.connections ?? {})) {
    const key = JSON.stringify([connection.profile, connection.upstream]);
    if (targets.has(key)) {
      addConfigIssue(
        context,
        "CONFIG_SCHEMA_INVALID",
        ["oauth", "connections", connectionRef],
        "only one OAuth connection may target a profile and upstream",
        "Use one connection per profile/upstream target."
      );
    }
    targets.add(key);
  }
}

function validateIsolationTransport(
  path: (string | number)[],
  target: string,
  transport: UpstreamTransportReference["transport"],
  context: z.RefinementCtx
): void {
  if (transport === "stdio") return;
  addConfigIssue(
    context,
    "CONFIG_SCHEMA_INVALID",
    path,
    `profile isolation requires a stdio transport; ${target} uses '${transport}'`,
    "Remove isolation for this target, or configure the target upstream with transport 'stdio'."
  );
}

function validateMergedIsolationDestinations(
  profileName: string,
  upstreamName: string,
  profileIsolation: ProfileIsolationReferenceInput | undefined,
  upstreamIsolation: ProfileIsolationReferenceInput | undefined,
  context: z.RefinementCtx
): void {
  if (profileIsolation === undefined || upstreamIsolation === undefined) return;
  const mappings: ReadonlyArray<{
    readonly name: "files" | "containerVolumes";
    readonly profileEntries: readonly IsolationDestinationInput[];
    readonly upstreamEntries: readonly IsolationDestinationInput[];
  }> = [
    {
      name: "files",
      profileEntries: profileIsolation.files ?? [],
      upstreamEntries: upstreamIsolation.files ?? []
    },
    {
      name: "containerVolumes",
      profileEntries: profileIsolation.containerVolumes ?? [],
      upstreamEntries: upstreamIsolation.containerVolumes ?? []
    }
  ];
  for (const mapping of mappings) {
    const destinations = new Set(mapping.profileEntries.map((entry) => entry.destination));
    for (const [index, entry] of mapping.upstreamEntries.entries()) {
      if (!destinations.has(entry.destination)) continue;
      addConfigIssue(
        context,
        "CONFIG_SCHEMA_INVALID",
        ["profiles", profileName, "upstreams", upstreamName, "isolation", mapping.name, index, "destination"],
        `named-upstream isolation ${mapping.name} cannot duplicate a profile isolation destination`,
        "Use a distinct destination for the named upstream, or keep the mapping only at the profile level."
      );
    }
  }
  validateMergedIsolationEnvironmentBindings(profileName, upstreamName, profileIsolation, upstreamIsolation, context);
}

function validateMergedIsolationEnvironmentBindings(
  profileName: string,
  upstreamName: string,
  profileIsolation: ProfileIsolationReferenceInput,
  upstreamIsolation: ProfileIsolationReferenceInput,
  context: z.RefinementCtx
): void {
  const profileFiles = isolationEnvironmentIndex(profileIsolation.files ?? []);
  const upstreamFiles = isolationEnvironmentIndex(upstreamIsolation.files ?? []);
  const profileVolumes = isolationEnvironmentIndex(profileIsolation.containerVolumes ?? []);
  const upstreamVolumes = isolationEnvironmentIndex(upstreamIsolation.containerVolumes ?? []);

  for (const [environment, upstreamFile] of upstreamFiles) {
    if (profileFiles.has(environment)) {
      addMergedIsolationEnvironmentIssue(context, profileName, upstreamName, "files", upstreamFile.index, "cannot duplicate a profile file binding");
    }
    const profileVolume = profileVolumes.get(environment);
    if (profileVolume !== undefined && profileVolume.entry.source !== upstreamFile.entry.destination) {
      addMergedIsolationEnvironmentIssue(
        context,
        profileName,
        upstreamName,
        "files",
        upstreamFile.index,
        "must match the source of the profile container volume"
      );
    }
  }

  for (const [environment, upstreamVolume] of upstreamVolumes) {
    if (profileVolumes.has(environment)) {
      addMergedIsolationEnvironmentIssue(
        context,
        profileName,
        upstreamName,
        "containerVolumes",
        upstreamVolume.index,
        "cannot duplicate a profile container volume binding"
      );
    }
    const profileFile = profileFiles.get(environment);
    if (profileFile !== undefined && profileFile.entry.destination !== upstreamVolume.entry.source) {
      addMergedIsolationEnvironmentIssue(
        context,
        profileName,
        upstreamName,
        "containerVolumes",
        upstreamVolume.index,
        "must mount the matching profile copied-file destination"
      );
    }
  }
}

function isolationEnvironmentIndex<T extends { readonly environment?: string }>(
  entries: readonly T[]
): Map<string, { readonly entry: T; readonly index: number }> {
  const bindings = new Map<string, { readonly entry: T; readonly index: number }>();
  for (const [index, entry] of entries.entries()) {
    if (entry.environment !== undefined) bindings.set(entry.environment.toLocaleUpperCase("en-US"), { entry, index });
  }
  return bindings;
}

function addMergedIsolationEnvironmentIssue(
  context: z.RefinementCtx,
  profileName: string,
  upstreamName: string,
  kind: "files" | "containerVolumes",
  index: number,
  explanation: string
): void {
  addConfigIssue(
    context,
    "CONFIG_SCHEMA_INVALID",
    ["profiles", profileName, "upstreams", upstreamName, "isolation", kind, index, "environment"],
    `named-upstream isolation environment ${explanation}`,
    "Use a distinct environment name, or use the exact copied-file and container-volume pairing."
  );
}

function validateProfileState(
  value: { persistActiveProfile?: boolean; scope?: "process" | "session" | "workspace" | "global" },
  context: z.RefinementCtx,
  pathPrefix: readonly string[] = []
): void {
  const stateScope = value.scope ?? "process";
  const durableStateScope = stateScope === "workspace" || stateScope === "global";
  if (value.persistActiveProfile === true && !durableStateScope) {
    addConfigIssue(
      context,
      "CONFIG_SCHEMA_INVALID",
      [...pathPrefix, "scope"],
      "persistActiveProfile requires workspace or global scope",
      "Set state.scope to workspace or global, or disable persistence."
    );
  }
  if (durableStateScope && value.persistActiveProfile !== true) {
    addConfigIssue(
      context,
      "CONFIG_SCHEMA_INVALID",
      [...pathPrefix, "persistActiveProfile"],
      "workspace and global profile state require explicit persistence opt-in",
      "Set state.persistActiveProfile to true or use process or session scope."
    );
  }
}

type ConfigVersionSurface = {
  readonly version: string;
  readonly security?: { readonly allowPlaintextSecrets?: unknown; readonly redactSecrets?: unknown };
  readonly audit?: { readonly redact?: unknown };
  readonly upstream?: { readonly transport?: unknown };
  readonly upstreams?: Record<string, { readonly transport?: unknown }>;
  readonly oauth?: unknown;
};

/** Canonical versions remove aliases that the explicit v1-to-v2 migrator can preserve without changing behavior. */
function validateConfigVersionSurface(value: ConfigVersionSurface, context: z.RefinementCtx): void {
  const rejectLegacyAlias = (path: (string | number)[], explanation: string, remediation: string): void => {
    addConfigIssue(context, "UNSUPPORTED_CONFIG_OPTION", path, explanation, remediation);
  };

  if (value.version !== "3" && value.oauth !== undefined) {
    rejectLegacyAlias(
      ["oauth"],
      "OAuth connection bindings require config version 3",
      "Run `miftah migrate-config --config <file> --write` before adding oauth connections."
    );
  }
  if (value.version === "1") return;

  if (value.security?.allowPlaintextSecrets !== undefined) {
    rejectLegacyAlias(
      ["security", "allowPlaintextSecrets"],
      "security.allowPlaintextSecrets is a version 1 compatibility alias",
      "Use secrets.allowPlaintextSecrets, or run `miftah migrate-config --config <file> --write`."
    );
  }
  if (value.security?.redactSecrets !== undefined && value.security.redactSecrets !== false) {
    rejectLegacyAlias(
      ["security", "redactSecrets"],
      "security.redactSecrets is redundant because secret redaction is always enabled",
      "Remove this option, or run `miftah migrate-config --config <file> --write`."
    );
  }
  if (value.audit?.redact !== undefined && value.audit.redact !== false) {
    rejectLegacyAlias(
      ["audit", "redact"],
      "audit.redact is redundant because audit redaction is always enabled",
      "Remove this option, or run `miftah migrate-config --config <file> --write`."
    );
  }

  const validateTransport = (transport: unknown, path: (string | number)[]): void => {
    if (transport !== "http") return;
    rejectLegacyAlias(
      path,
      "the http upstream transport is a version 1 compatibility alias for Streamable HTTP",
      "Use streamable-http, or run `miftah migrate-config --config <file> --write`."
    );
  };
  validateTransport(value.upstream?.transport, ["upstream", "transport"]);
  for (const name of Object.keys(value.upstreams ?? {}).sort()) {
    validateTransport(value.upstreams?.[name]?.transport, ["upstreams", name, "transport"]);
  }

}

/** The strict, supported configuration surface used for runtime output and JSON Schema generation. */
export const miftahPublicConfigSchema = z
  .object({
    version: z.enum(SUPPORTED_CONFIG_VERSIONS),
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
    secrets: secretsSchema.optional(),
    plugins: pluginsSchema.optional(),
    state: publicStateSchema.optional(),
    server: publicServerSchema.optional(),
    oauth: oauthConfigSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    validateConfigReferences(value, context);
    validateConfigVersionSurface(value, context);
  });

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
    plugins: pluginsSchema.optional(),
    state: stateSchema.optional(),
    server: serverSchema.optional(),
    oauth: oauthConfigSchema.optional(),
    ui: unsupportedOptionSchema
  })
  .strict()
  .superRefine((value, context) => {
    validateConfigReferences(value, context);
    validateConfigVersionSurface(value, context);

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

    for (const option of ["startMode", "cache"] as const) {
      if (value.process?.[option] !== undefined) {
        rejectUnsupportedOption(
          ["process", option],
          `${option} is not implemented; Miftah always starts cached upstream sessions lazily`
        );
      }
    }
    if (value.process?.maxRestarts !== undefined && value.process.restartOnCrash !== true) {
      addConfigIssue(
        context,
        "CONFIG_SCHEMA_INVALID",
        ["process", "maxRestarts"],
        "maxRestarts requires process.restartOnCrash to be true",
        "Set process.restartOnCrash to true or remove process.maxRestarts."
      );
    }

    if (value.security?.redactSecrets === false) {
      rejectUnsupportedOption(["security", "redactSecrets"], "secret redaction is always enabled and cannot be disabled");
    }

    if (value.audit?.redact === false) {
      rejectUnsupportedOption(["audit", "redact"], "audit redaction is always enabled and cannot be disabled");
    }

    for (const option of ["managementToolPrefix", "upstreamToolNamespace"] as const) {
      if (value.tooling?.[option] !== undefined) {
        rejectUnsupportedOption(["tooling", option], `${option} is not implemented`);
      }
    }

    if (value.state?.path !== undefined) {
      rejectUnsupportedOption(
        ["state", "path"],
        "custom profile-state paths are not supported; choose workspace or global scope"
      );
    }
    if (value.state !== undefined) {
      validateProfileState(value.state, context, ["state"]);
    }
    if (value.ui !== undefined) {
      rejectUnsupportedOption(["ui"], "a Miftah UI is not implemented");
    }
  });

/** Input accepted by {@link miftahConfigSchema} before validation. */
export type MiftahConfigInput = z.input<typeof miftahConfigSchema>;
