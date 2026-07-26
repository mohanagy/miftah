import { dirname } from "node:path";
import { AuditLogger } from "../audit/audit-logger.js";
import { AuditTrail } from "../audit/audit-trail.js";
import {
  applyConfigReplacement,
  readConfigMigrationSource,
  restoreConfigReplacementWithoutPublishingBackup,
  type ConfigMigrationSource
} from "../cli/migrate-config.js";
import {
  assertSafeProviderAdapterAccountProfileName,
  getProviderAdapterForConfiguration,
  ProviderAdapterAccountProfileError
} from "../config/provider-adapters.js";
import { planConfigMigration } from "../config/migrate-config.js";
import { resolvePath } from "../config/path-resolve.js";
import type { MiftahConfig, ProfileConfig } from "../config/types.js";
import { validateConfig } from "../config/validate-config.js";
import { MiftahError } from "../utils/errors.js";

const environmentVariableName = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const environmentReference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u;
const supportedTemplateFields = new Set(["description", "env", "policy"]);

export interface EnvironmentProfileAdditionRequest {
  readonly configPath: string;
  /** New account identifier; it is stored only as a configuration key and audit label. */
  readonly profile: string;
  /** Optional human-facing account label; credentials are never accepted here. */
  readonly description?: string;
  /** Name of the inherited process environment variable that contains this account's credential. */
  readonly credentialEnv: string;
  /** Changes only the durable default; existing MCP clients still require a restart or new connection. */
  readonly makeDefault?: boolean;
}

export interface EnvironmentProfileAdditionPlan {
  readonly profile: string;
  readonly config: MiftahConfig;
  readonly actions: readonly string[];
}

/** Public command and Console results deliberately omit the candidate configuration. */
export type EnvironmentProfileAdditionReport = Omit<EnvironmentProfileAdditionPlan, "config"> & {
  readonly changed: true;
  readonly write: true;
  /** Exact original bytes retained before the guarded configuration replacement. */
  readonly backupPath?: string;
};

export interface EnvironmentProfileAdditionAuditSink {
  ensureWritable(): Promise<void>;
  /** Records durable intent before Miftah mutates the selected configuration. */
  intent(event: { readonly profile: string }): Promise<void>;
  /** Records only a completed durable static-credential profile addition. */
  record(event: { readonly profile: string; readonly status: "success" }): Promise<void>;
}

export interface EnvironmentProfileAdditionDependencies {
  /** A source snapshot already verified by an embedding such as Console. */
  readonly trustedSource?: ConfigMigrationSource;
  /** Console callers provide their own redacted local lifecycle journal. */
  readonly audit?: EnvironmentProfileAdditionAuditSink;
}

function sourceInput(source: ConfigMigrationSource): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes));
  } catch {
    throw new MiftahError("CONFIG_INVALID_JSON", "CONFIG_INVALID_JSON: configuration is not valid JSON");
  }
}

function unsupported(): never {
  throw new MiftahError(
    "ENVIRONMENT_PROFILE_ADDITION_UNSUPPORTED",
    "ENVIRONMENT_PROFILE_ADDITION_UNSUPPORTED: this configuration does not have one simple environment-backed credential profile to copy safely"
  );
}

function inputInvalid(message: string): never {
  throw new MiftahError("ENVIRONMENT_PROFILE_INPUT_INVALID", `ENVIRONMENT_PROFILE_INPUT_INVALID: ${message}`);
}

function assertProfileName(profile: unknown): asserts profile is string {
  if (typeof profile !== "string") inputInvalid("choose a safe profile name");
  try {
    assertSafeProviderAdapterAccountProfileName(profile);
  } catch (error) {
    if (error instanceof ProviderAdapterAccountProfileError) inputInvalid("choose a safe profile name");
    throw error;
  }
}

function assertDescription(description: unknown): asserts description is string | undefined {
  if (description === undefined) return;
  if (
    typeof description !== "string" ||
    description.length === 0 ||
    description.length > 1_024 ||
    description.trim() !== description ||
    Array.from(description).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    inputInvalid("choose an optional trimmed account description without control characters");
  }
}

function assertCredentialEnvironmentName(credentialEnv: unknown): asserts credentialEnv is string {
  if (typeof credentialEnv !== "string" || !environmentVariableName.test(credentialEnv)) {
    inputInvalid("choose an environment variable name, not a secret value");
  }
}

function templateCredentialBinding(profile: ProfileConfig): readonly [target: string, source: string] {
  if (Object.keys(profile).some((key) => !supportedTemplateFields.has(key))) unsupported();
  const entries = Object.entries(profile.env ?? {});
  if (entries.length !== 1) unsupported();
  const [target, source] = entries[0]!;
  if (!environmentVariableName.test(target) || environmentReference.exec(source) === null) unsupported();
  return [target, source];
}

interface EnvironmentProfileTemplate {
  readonly profile: ProfileConfig;
  readonly target: string;
}

function supportedEnvironmentProfileTemplate(config: MiftahConfig): EnvironmentProfileTemplate | undefined {
  if (
    getProviderAdapterForConfiguration(config) !== undefined ||
    (config.version === "3" && config.oauth?.connections !== undefined) ||
    config.upstream === undefined ||
    config.upstream.transport !== "stdio" ||
    config.upstreams !== undefined
  ) {
    return undefined;
  }
  const template = config.profiles[config.defaultProfile];
  if (template === undefined) return undefined;
  try {
    const [target] = templateCredentialBinding(template);
    for (const profile of Object.values(config.profiles)) {
      const [existingTarget] = templateCredentialBinding(profile);
      if (existingTarget !== target || profile.policy !== template.policy) return undefined;
    }
    return { profile: template, target };
  } catch {
    return undefined;
  }
}

/** Returns the one local child-process environment destination safe for another named account, if any. */
export function environmentProfileCredentialDestination(config: MiftahConfig): string | undefined {
  return supportedEnvironmentProfileTemplate(config)?.target;
}

function environmentProfile(template: ProfileConfig, target: string, options: EnvironmentProfileAdditionRequest): ProfileConfig {
  return {
    ...(template.policy === undefined ? {} : { policy: template.policy }),
    ...(options.description === undefined ? {} : { description: options.description }),
    env: { [target]: `\${${options.credentialEnv}}` }
  };
}

/**
 * Plans one additional static-credential account from a standard configuration.
 * The scope is deliberately narrow: only one existing literal
 * `${ENVIRONMENT_VARIABLE}` binding can be replaced, so setup never parses,
 * stores, or duplicates a secret value or an arbitrary profile override.
 */
export function planEnvironmentProfileAddition(
  input: unknown,
  options: EnvironmentProfileAdditionRequest
): EnvironmentProfileAdditionPlan {
  assertProfileName(options.profile);
  assertDescription(options.description);
  assertCredentialEnvironmentName(options.credentialEnv);

  const migrated = planConfigMigration(input);
  const config = structuredClone(migrated.config) as MiftahConfig;
  const template = supportedEnvironmentProfileTemplate(config);
  if (template === undefined) unsupported();
  if (Object.hasOwn(config.profiles, options.profile)) {
    throw new MiftahError("PROFILE_ALREADY_EXISTS", "PROFILE_ALREADY_EXISTS: account profile already exists");
  }
  const credentialReference = `\${${options.credentialEnv}}`;
  if (Object.values(config.profiles).some((profile) => Object.values(profile.env ?? {}).includes(credentialReference))) {
    inputInvalid("choose a distinct environment variable name for this account");
  }

  const candidate = structuredClone(config) as MiftahConfig;
  candidate.profiles[options.profile] = environmentProfile(template.profile, template.target, options);
  if (options.makeDefault === true) candidate.defaultProfile = options.profile;
  candidate.security = {
    ...candidate.security,
    requireProfileSwitchConfirmation: true,
    requireExplicitSelectionForDestructive: true
  };
  validateConfig(candidate);

  return {
    profile: options.profile,
    config: candidate,
    actions: [
      ...migrated.actions,
      `Created environment-backed account profile '${options.profile}'.`,
      ...(options.makeDefault === true ? [`Set durable default profile to '${options.profile}'.`] : [])
    ]
  };
}

class ConfiguredEnvironmentProfileAuditSink implements EnvironmentProfileAdditionAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/environment-profile-add-intent",
      name: "profile",
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/environment-profile-add",
      name: "profile",
      profile: event.profile,
      status: event.status
    });
  }
}

function configuredAuditSink(config: MiftahConfig, configPath: string): EnvironmentProfileAdditionAuditSink | undefined {
  if (config.audit?.enabled === false || config.audit?.path === undefined) return undefined;
  const logger = new AuditLogger(resolvePath(config.audit.path, dirname(configPath)), {
    includeArguments: config.audit.includeArguments,
    failureMode: config.audit.failureMode,
    rotation: config.audit.rotation,
    integrity: config.audit.integrity
  });
  return new ConfiguredEnvironmentProfileAuditSink(new AuditTrail(config.name, logger));
}

function serializedConfig(config: MiftahConfig): Buffer {
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
}

async function restoreAfterAuditFailure(
  configPath: string,
  source: ConfigMigrationSource,
  candidate: MiftahConfig
): Promise<void> {
  const replacement = await readConfigMigrationSource(configPath);
  if (!replacement.originalBytes.equals(serializedConfig(candidate))) {
    throw new MiftahError(
      "AUDIT_WRITE_FAILED",
      "AUDIT_WRITE_FAILED: required audit finalization failed and configuration recovery could not be confirmed"
    );
  }
  await restoreConfigReplacementWithoutPublishingBackup(configPath, replacement, source);
}

function auditFailureAfterRestoration(backupPath: string): MiftahError {
  return new MiftahError(
    "AUDIT_WRITE_FAILED",
    `AUDIT_WRITE_FAILED: required audit finalization failed; configuration was restored and the original configuration backup was retained at '${backupPath}'`,
    { backupPaths: [backupPath] }
  );
}

function auditFailureWithUnconfirmedRecovery(backupPath: string): MiftahError {
  return new MiftahError(
    "AUDIT_WRITE_FAILED",
    `AUDIT_WRITE_FAILED: required audit finalization failed and configuration recovery could not be confirmed; the original configuration backup was retained at '${backupPath}'`,
    { backupPaths: [backupPath] }
  );
}

/**
 * Performs one fail-closed, guarded environment-profile replacement. It does
 * not start the upstream or read a credential; the running MCP process later
 * receives its selected inherited environment variable in the usual way.
 */
export async function runEnvironmentProfileAddition(
  options: EnvironmentProfileAdditionRequest,
  dependencies: EnvironmentProfileAdditionDependencies = {}
): Promise<EnvironmentProfileAdditionReport> {
  const configPath = resolvePath(options.configPath);
  const source = dependencies.trustedSource ?? await readConfigMigrationSource(configPath);
  const plan = planEnvironmentProfileAddition(sourceInput(source), { ...options, configPath });
  const audit = dependencies.audit ?? configuredAuditSink(plan.config, configPath);
  await audit?.ensureWritable();
  await audit?.intent({ profile: plan.profile });
  const backupPath = await applyConfigReplacement(configPath, source, plan.config);
  try {
    await audit?.record({ profile: plan.profile, status: "success" });
  } catch {
    try {
      await restoreAfterAuditFailure(configPath, source, plan.config);
    } catch {
      throw auditFailureWithUnconfirmedRecovery(backupPath);
    }
    throw auditFailureAfterRestoration(backupPath);
  }
  return {
    changed: true,
    write: true,
    profile: plan.profile,
    actions: plan.actions,
    ...(backupPath === undefined ? {} : { backupPath })
  };
}
