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
    requireProfileSwitchConfirmation: z.boolean().optional(),
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

const publicAuditSchema = z
  .object({
    enabled: z.boolean().optional(),
    path: z.string().optional(),
    format: z.literal("jsonl").optional(),
    includeArguments: z.boolean().optional(),
    redact: z.literal(true).optional(),
    failureMode: z.enum(["fail-open", "fail-closed"]).optional()
  })
  .strict();

const auditSchema = z
  .object({
    enabled: z.boolean().optional(),
    path: z.string().optional(),
    format: z.literal("jsonl").optional(),
    includeArguments: z.boolean().optional(),
    redact: z.boolean().optional(),
    failureMode: z.enum(["fail-open", "fail-closed"]).optional()
  })
  .strict();

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

type ConfigReferenceInput = {
  defaultProfile: string;
  upstream?: unknown;
  upstreams?: Record<string, unknown>;
  profiles: Record<
    string,
    {
      policy?: string;
      isolation?: ProfileIsolationReferenceInput;
      upstreams?: Record<string, { isolation?: ProfileIsolationReferenceInput }>;
    }
  >;
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
      const override = profile.upstreams?.[upstreamName];
      if (override !== undefined) {
        validateMergedIsolationDestinations(profileName, upstreamName, profile.isolation, override.isolation, context);
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
    secrets: secretsSchema.optional(),
    state: publicStateSchema.optional()
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
