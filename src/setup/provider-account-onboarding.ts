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
  buildProviderAdapterAccountProfile,
  getProviderAdapterForAccountProvisioning,
  providerAdapterStateDirectoryKey,
  type ProviderAdapterDefinition,
  type ProviderIdentityProbeContract,
  ProviderAdapterAccountProfileError
} from "../config/provider-adapters.js";
import { planConfigMigration } from "../config/migrate-config.js";
import { resolvePath } from "../config/path-resolve.js";
import type { IdentityConfig, MiftahConfig } from "../config/types.js";
import { validateConfig } from "../config/validate-config.js";
import { MiftahError } from "../utils/errors.js";

export interface ProviderAccountAdditionRequest {
  readonly profile: string;
  readonly description?: string;
  /** A non-secret provider credential-file path. The upstream retains its token cache. */
  readonly credentialFile: string;
  /** Opaque non-email identifier expected from the adapter's reviewed identity probe. */
  readonly expectedAccountId?: string;
  readonly identityProbeTool?: string;
  /** Changes only the durable default; running MCP clients must still restart. */
  readonly makeDefault?: boolean;
}

export interface ProviderAccountAdditionPlan {
  readonly adapter: string;
  readonly profile: string;
  readonly config: MiftahConfig;
  readonly actions: readonly string[];
}

export interface ProviderAccountAdditionCommandOptions extends ProviderAccountAdditionRequest {
  readonly configPath: string;
}

export interface ProviderAccountAdditionReport extends ProviderAccountAdditionPlan {
  readonly changed: true;
  readonly write: true;
  /** A byte-exact recovery copy created when migration rewrote the selected configuration. */
  readonly backupPath?: string;
}

export interface ProviderAccountAdditionAuditSink {
  ensureWritable(): Promise<void>;
  /** Records the durable intent before Miftah mutates the selected configuration. */
  intent(event: { readonly profile: string }): Promise<void>;
  record(event: { readonly profile: string; readonly status: "success" }): Promise<void>;
}

export interface ProviderAccountAdditionDependencies {
  /** Source captured by a caller that already verified and opened the exact configuration file. */
  readonly trustedSource?: ConfigMigrationSource;
  /** Console callers use their own redacted local lifecycle journal. */
  readonly audit?: ProviderAccountAdditionAuditSink;
}

function sourceInput(source: ConfigMigrationSource): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes));
  } catch {
    throw new MiftahError("CONFIG_INVALID_JSON", "CONFIG_INVALID_JSON: configuration is not valid JSON");
  }
}

function providerAccountAdditionUnavailable(): never {
  throw new MiftahError(
    "PROVIDER_ACCOUNT_ADDITION_UNSUPPORTED",
    "PROVIDER_ACCOUNT_ADDITION_UNSUPPORTED: this configuration does not support reviewed provider-owned account addition"
  );
}

function providerAccountInputInvalid(error: ProviderAdapterAccountProfileError): never {
  if (error.reason === "unsupported") providerAccountAdditionUnavailable();
  throw new MiftahError(
    "PROVIDER_ACCOUNT_INPUT_INVALID",
    error.reason === "profile"
      ? "PROVIDER_ACCOUNT_INPUT_INVALID: choose a safe profile name"
      : error.reason === "identity"
        ? "PROVIDER_ACCOUNT_INPUT_INVALID: keep one opaque account identity contract across every provider profile"
      : "PROVIDER_ACCOUNT_INPUT_INVALID: choose an absolute literal credential-file path"
  );
}

function matchesReviewedIdentityContract(
  identity: IdentityConfig,
  contract: ProviderIdentityProbeContract
): boolean {
  const requiredRisks: readonly string[] = identity.requiredForRisk ?? [];
  return (
    identity.probe.resultFormat === contract.resultFormat &&
    identity.expected.provider === contract.provider &&
    Object.keys(identity.expected).every((field) => field === "provider" || field === "accountId") &&
    identity.maxAgeMs === 3_600_000 &&
    identity.selectionMode === undefined &&
    new Set(requiredRisks).size === 2 &&
    requiredRisks.includes("write") &&
    requiredRisks.includes("destructive")
  );
}

function existingProviderIdentityProbe(
  config: MiftahConfig,
  adapter: ProviderAdapterDefinition
): string | undefined {
  const identities = Object.values(config.profiles).map((profile) => profile.identity);
  const configured = identities.filter(
    (identity) => identity?.expected.accountId !== undefined
  );
  if (configured.length === 0) {
    if (identities.some((identity) => identity !== undefined)) providerAccountAdditionUnavailable();
    return undefined;
  }
  if (configured.length !== identities.length) providerAccountAdditionUnavailable();
  const contract = adapter.identity.preferredProbe;
  if (contract === undefined) providerAccountAdditionUnavailable();
  const tools = new Set(configured.map((identity) => identity!.probe.tool));
  const accountIds = new Set(configured.map((identity) => identity!.expected.accountId));
  if (
    tools.size !== 1 ||
    accountIds.size !== configured.length ||
    configured.some((identity) => !matchesReviewedIdentityContract(identity!, contract))
  ) {
    providerAccountAdditionUnavailable();
  }
  return configured[0]!.probe.tool;
}

/**
 * Plans one additional provider-owned account from a fully trusted existing
 * adapter configuration. It never reads a provider token cache or writes any
 * file; callers own the guarded transaction.
 */
export function planProviderAccountAddition(
  input: unknown,
  options: ProviderAccountAdditionCommandOptions
): ProviderAccountAdditionPlan {
  const migrated = planConfigMigration(input);
  const config = structuredClone(migrated.config) as MiftahConfig;
  const adapter = getProviderAdapterForAccountProvisioning(config);
  if (adapter?.accountProvisioning === undefined) {
    providerAccountAdditionUnavailable();
  }
  try {
    assertSafeProviderAdapterAccountProfileName(options.profile);
  } catch (error) {
    if (error instanceof ProviderAdapterAccountProfileError) providerAccountInputInvalid(error);
    throw error;
  }
  if (Object.hasOwn(config.profiles, options.profile)) {
    throw new MiftahError("PROFILE_ALREADY_EXISTS", "PROFILE_ALREADY_EXISTS: account profile already exists");
  }
  const existingIdentityProbe = existingProviderIdentityProbe(config, adapter);
  if (
    (existingIdentityProbe === undefined && options.expectedAccountId !== undefined) ||
    (existingIdentityProbe !== undefined && options.expectedAccountId === undefined) ||
    (options.identityProbeTool !== undefined && options.identityProbeTool !== existingIdentityProbe) ||
    (options.expectedAccountId !== undefined && Object.values(config.profiles).some(
      (profile) => profile.identity?.expected.accountId === options.expectedAccountId
    ))
  ) {
    providerAccountInputInvalid(new ProviderAdapterAccountProfileError("identity"));
  }

  // Validate the new profile name and durable-default choice before its name
  // can become part of an adapter-owned state-directory path.
  const candidate = structuredClone(config) as MiftahConfig;
  candidate.profiles[options.profile] = {};
  if (options.makeDefault === true) candidate.defaultProfile = options.profile;
  validateConfig(candidate);

  let profile;
  try {
    profile = buildProviderAdapterAccountProfile(adapter, {
      configurationName: candidate.name,
      configurationPath: resolvePath(options.configPath),
      profile: options.profile,
      ...(options.description === undefined ? {} : { description: options.description }),
      credentialFile: options.credentialFile,
      ...(options.expectedAccountId === undefined ? {} : { expectedAccountId: options.expectedAccountId }),
      ...((options.identityProbeTool ?? existingIdentityProbe) === undefined
        ? {}
        : { identityProbeTool: options.identityProbeTool ?? existingIdentityProbe })
    });
  } catch (error) {
    if (error instanceof ProviderAdapterAccountProfileError) {
      providerAccountInputInvalid(error);
    }
    throw error;
  }
  const stateDirectory = profile.env?.[adapter.accountProvisioning.stateDirectory.environment];
  const stateDirectoryKey = typeof stateDirectory === "string"
    ? providerAdapterStateDirectoryKey(stateDirectory)
    : undefined;
  if (
    stateDirectoryKey === undefined ||
    Object.values(config.profiles).some(
      (existing) => {
        const existingStateDirectory = existing.env?.[adapter.accountProvisioning!.stateDirectory.environment];
        return typeof existingStateDirectory === "string" &&
          providerAdapterStateDirectoryKey(existingStateDirectory) === stateDirectoryKey;
      }
    )
  ) {
    providerAccountAdditionUnavailable();
  }
  candidate.profiles[options.profile] = profile;
  validateConfig(candidate);

  return {
    adapter: adapter.displayName,
    profile: options.profile,
    config: candidate,
    actions: [
      ...migrated.actions,
      `Created provider-owned account profile '${options.profile}'.`,
      ...(options.makeDefault === true ? [`Set durable default profile to '${options.profile}'.`] : [])
    ]
  };
}

class ConfiguredProviderAccountAuditSink implements ProviderAccountAdditionAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/provider-profile-add-intent",
      name: "profile",
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "config/provider-profile-add",
      name: "profile",
      profile: event.profile,
      status: event.status
    });
  }
}

function configuredAuditSink(config: MiftahConfig, configPath: string): ProviderAccountAdditionAuditSink | undefined {
  if (config.audit?.enabled === false || config.audit?.path === undefined) return undefined;
  const logger = new AuditLogger(resolvePath(config.audit.path, dirname(configPath)), {
    includeArguments: config.audit.includeArguments,
    failureMode: config.audit.failureMode,
    rotation: config.audit.rotation,
    integrity: config.audit.integrity
  });
  return new ConfiguredProviderAccountAuditSink(new AuditTrail(config.name, logger));
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
  // Refuse to overwrite an externally changed candidate. The durable intent
  // record remains available for reconciliation when recovery cannot proceed.
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

/** Performs one fail-closed, guarded account-profile replacement with a recovery backup when needed. */
export async function runProviderAccountAddition(
  options: ProviderAccountAdditionCommandOptions,
  dependencies: ProviderAccountAdditionDependencies = {}
): Promise<ProviderAccountAdditionReport> {
  const configPath = resolvePath(options.configPath);
  const source = dependencies.trustedSource ?? await readConfigMigrationSource(configPath);
  const plan = planProviderAccountAddition(sourceInput(source), { ...options, configPath });
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
    ...plan,
    ...(backupPath === undefined ? {} : { backupPath })
  };
}
