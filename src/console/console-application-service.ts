import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readAuditJsonl } from "../cli/audit-jsonl.js";
import { readConfigMigrationSource, type ConfigMigrationSource } from "../cli/migrate-config.js";
import { planConfigMigration } from "../config/migrate-config.js";
import { resolvePath } from "../config/path-resolve.js";
import {
  buildPresetConfig,
  isWindowsNpxPresetUnavailable,
  PresetCatalogError
} from "../config/presets.js";
import type { PresetBuildOptions } from "../config/presets.js";
import type { MiftahConfig } from "../config/types.js";
import { validateConfig } from "../config/validate-config.js";
import { AuditLogger } from "../audit/audit-logger.js";
import { AuditTrail, type AuditLifecycleInput } from "../audit/audit-trail.js";
import type {
  ConnectionAddCommandReport,
  ConnectionApplicationAuditEvent,
  ConnectionApplicationAuditSink,
  OAuthConnectionAddRequest
} from "../oauth/connection-application-service.js";
import { runConnectionAddCommand } from "../oauth/connection-application-service.js";
import {
  NativeOAuthCommandRuntimeFactory,
  OAuthConnectionCommandService
} from "../oauth/connection-command-service.js";
import { SecretRedactor } from "../secrets/redact.js";
import { loadConfig } from "../config/load-config.js";
import { MiftahError } from "../utils/errors.js";
import { parseOAuthConnectionRef } from "../oauth/connection-types.js";
import { discoverNativeOAuthConnection } from "../oauth/remote-oauth-discovery.js";
import {
  createSetupConfigurationPlan,
  describeSetupConfiguration,
  publishFirstRunSetupConfigurationPlan
} from "../setup/setup-configuration.js";
import type { SetupConfigurationPreview } from "../setup/setup-configuration.js";
import {
  createSetupCompletion,
  environmentReferencesFromConfig,
  inspectConfigEnvironment,
  type SetupCompletion
} from "../setup/setup-completion.js";
import {
  planNativeOAuthFirstRunConfiguration,
  runNativeOAuthAccountAddition,
  selectedExistingUpstream,
  type NativeOAuthAccountAdditionAuditSink
} from "../setup/native-oauth-onboarding.js";
import {
  ClientEntryImportError,
  createImportedClientConfiguration
} from "../setup/client-entry-import.js";
import {
  runProfileReadinessFromLoadedConfig,
  type ProfileReadinessReport
} from "../setup/profile-readiness.js";
import type { SetupDraft, SetupDraftInput } from "../setup/setup-draft.js";
import {
  runProviderAccountAddition,
  type ProviderAccountAdditionAuditSink,
  type ProviderAccountAdditionReport
} from "../setup/provider-account-onboarding.js";
import {
  runEnvironmentProfileAddition,
  type EnvironmentProfileAdditionAuditSink,
  type EnvironmentProfileAdditionReport
} from "../setup/environment-profile-onboarding.js";
import {
  runDefaultProfileChange,
  type DefaultProfileChangeAuditSink,
  type DefaultProfileChangeReport
} from "../setup/profile-default-onboarding.js";
import {
  runProfileDescriptionChange,
  type ProfileDescriptionChangeAuditSink,
  type ProfileDescriptionChangeReport
} from "../setup/profile-description-onboarding.js";
import {
  runProfileRemoval,
  type ProfileRemovalAuditSink,
  type ProfileRemovalReport
} from "../setup/profile-removal-onboarding.js";
import {
  runProfileRename,
  type ProfileRenameAuditSink,
  type ProfileRenameReport
} from "../setup/profile-rename-onboarding.js";
import type { OAuthProfileRenameDependencies } from "../oauth/profile-rename-transaction.js";
import {
  createWindowsPrivateDirectoryInPrivateParent,
  verifyWindowsConfigPathsSecurity
} from "../cli/windows-config-acl.js";
import {
  renderClientSnippets,
  type ClientLauncher,
  type ClientSelection,
  type ClientSnippet
} from "../cli/client-snippets.js";
import {
  consoleInitializedConfigMetadata,
  type ConsoleConfigMetadata
} from "./console-config-metadata.js";
import type { ConsoleTrustedConfiguration } from "./console-trusted-configuration.js";

export type {
  ConsoleAuthenticationMetadata,
  ConsoleConfigCatalog,
  ConsoleConfigMetadata,
  ConsoleDiscoveredConfiguration,
  ConsoleInitializedConfigMetadata,
  ConsoleUninitializedConfigMetadata
} from "./console-config-metadata.js";

export interface ConsoleConnectionAddRequest extends OAuthConnectionAddRequest {
  readonly connectionRef?: string;
}

/** Console responses never expose local configuration or recovery-file paths. */
export type ConsoleConnectionAddReport = Omit<ConnectionAddCommandReport, "backupPath">;

/** First-run native OAuth returns a truthful local handoff without exposing configuration paths. */
export type ConsoleFirstRunNativeOAuthOnboardingReport = ConsoleConnectionAddReport & {
  readonly completion: SetupCompletion;
};

export interface ConsoleNativeOAuthOnboardingRequest {
  readonly name: string;
  readonly profile: string;
  readonly description?: string;
  readonly resource: string;
  readonly issuer: string;
  readonly clientRegistration: string;
  readonly scopes: readonly string[];
}

/** Endpoint-first native OAuth onboarding keeps issuer and registration internals out of the Console request. */
export interface ConsoleDiscoveredNativeOAuthOnboardingRequest {
  readonly name: string;
  readonly profile: string;
  readonly description?: string;
  readonly resource: string;
}

/** Existing configurations derive the exact resource from their selected upstream, never from the browser request. */
export interface ConsoleDiscoveredNativeOAuthConnectionRequest {
  readonly profile: string;
  readonly upstream: string;
}

/** Adds a new, independently authorized account profile from an already configured HTTPS upstream. */
export interface ConsoleDiscoveredNativeOAuthAccountRequest {
  readonly profile: string;
  readonly description?: string;
  readonly upstream: string;
  readonly makeDefault?: boolean;
}

/** Adds one account through a recognized upstream-owned provider adapter. */
export interface ConsoleProviderAccountAdditionRequest {
  readonly profile: string;
  readonly description?: string;
  /** Non-secret credential-file path; the adapter retains its own token cache. */
  readonly credentialFile: string;
  readonly makeDefault?: boolean;
}

/** Console responses intentionally omit config bytes, local paths, and backup paths. */
export type ConsoleProviderAccountAdditionReport = Pick<
  ProviderAccountAdditionReport,
  "changed" | "write" | "adapter" | "profile" | "actions"
>;

/** Adds one static-credential account from the current standard local stdio configuration. */
export interface ConsoleEnvironmentProfileAdditionRequest {
  readonly profile: string;
  readonly description?: string;
  /** An inherited environment variable name, never a credential value. */
  readonly credentialEnv: string;
  readonly makeDefault?: boolean;
}

/** Console responses intentionally omit configuration bytes, recovery paths, and credential references. */
export type ConsoleEnvironmentProfileAdditionReport = Pick<
  EnvironmentProfileAdditionReport,
  "changed" | "write" | "profile" | "actions"
>;

/** Changes only the durable default for an already configured profile. */
export interface ConsoleDefaultProfileChangeRequest {
  readonly profile: string;
}

/** Console responses intentionally omit recovery paths and configuration bytes. */
export type ConsoleDefaultProfileChangeReport = Pick<
  DefaultProfileChangeReport,
  "changed" | "write" | "profile" | "actions"
>;

/** Sets or explicitly clears only one existing non-secret account label. */
export interface ConsoleProfileDescriptionChangeRequest {
  readonly profile: string;
  readonly description?: string;
  readonly clearDescription?: true;
}

/** Console responses intentionally omit descriptions, recovery paths, and configuration bytes. */
export type ConsoleProfileDescriptionChangeReport = Pick<
  ProfileDescriptionChangeReport,
  "changed" | "write" | "profile" | "actions"
>;

/** Removes one existing profile after any required durable references are explicitly reassigned. */
export interface ConsoleProfileRemovalRequest {
  readonly profile: string;
  readonly replacementProfile?: string;
}

/** Console responses intentionally omit profile contents, recovery paths, and configuration bytes. */
export type ConsoleProfileRemovalReport = Pick<
  ProfileRemovalReport,
  "changed" | "write" | "profile" | "replacementProfile" | "actions"
>;

/** Renames one profile and its configuration-owned durable references. */
export interface ConsoleProfileRenameRequest {
  readonly profile: string;
  readonly newProfile: string;
}

/** Console responses intentionally omit profile contents, recovery paths, and configuration bytes. */
export type ConsoleProfileRenameReport = Pick<
  ProfileRenameReport,
  "changed" | "write" | "profile" | "newProfile" | "actions"
>;

/** Non-secret input accepted for a known connector during first-run setup. */
export interface ConsolePresetOnboardingRequest extends PresetBuildOptions {
  readonly name: string;
  readonly preset: string;
}

/** Redacted outcome of creating one preset-backed Miftah configuration. */
export interface ConsolePresetOnboardingReport {
  readonly changed: true;
  readonly write: true;
  readonly name: string;
  readonly defaultProfile: string;
  readonly profileCount: number;
  readonly actions: readonly string[];
  /** Present for the built-in first-run flow; optional for custom ConsoleControlApplication implementations. */
  readonly completion?: SetupCompletion;
}

/** A validated first-run configuration summary that has not written local state. */
export interface ConsolePresetOnboardingPreview {
  readonly changed: false;
  readonly write: false;
  readonly name: string;
  readonly defaultProfile: string;
  readonly profileCount: number;
  readonly actions: readonly string[];
  /** Structural summary only; it omits paths, endpoints, launch arguments, and credential references. */
  readonly configuration: SetupConfigurationPreview;
}

/** Non-secret, explicitly selected local stdio or canonical HTTPS MCP entry pasted into first-run Console setup. */
export interface ConsoleClientEntryOnboardingRequest {
  readonly name: string;
  readonly entry: string;
  /** Bounded client configuration text. It is parsed in memory and never persisted or returned. */
  readonly document: string;
}

export interface ConsoleAuditRecord {
  readonly timestamp?: string;
  readonly kind?: string;
  readonly operation?: string;
  readonly name?: string;
  readonly profile?: string;
  readonly upstream?: string;
  readonly status?: string;
  readonly errorCode?: string;
}

export interface ConsoleProfileReadinessRequest {
  readonly profile: string;
  readonly upstream?: string;
  /** Internal transport cancellation; never accepted from or serialized to Console clients. */
  readonly signal?: AbortSignal;
}

export interface ConsoleHealth {
  readonly status: "ok";
  readonly config: { readonly name: string; readonly version: string };
  readonly audit: {
    readonly enabled: boolean;
    readonly state?: "healthy" | "failed";
    readonly lastFailure?: { readonly timestamp: string; readonly errorCode: "AUDIT_WRITE_FAILED" };
  };
  readonly restartRequiredForExistingClients: true;
}

export interface ConsoleControlApplication {
  health(): Promise<ConsoleHealth>;
  configMetadata(): Promise<ConsoleConfigMetadata>;
  /** Available only for a dashboard started without an explicit --config path. */
  selectConfiguration?(configurationId: string): Promise<ConsoleConfigMetadata>;
  /** Available only when the embedding supports first-run known-connector setup. */
  previewPreset?(request: ConsolePresetOnboardingRequest): Promise<ConsolePresetOnboardingPreview>;
  /** Available only when the embedding supports first-run known-connector setup. */
  onboardPreset?(request: ConsolePresetOnboardingRequest): Promise<ConsolePresetOnboardingReport>;
  /** Available only when the embedding supports a private, first-run connector setup checkpoint. */
  loadSetupDraft?(): Promise<SetupDraft | undefined>;
  /** Available only when the embedding supports a private, first-run connector setup checkpoint. */
  saveSetupDraft?(input: SetupDraftInput, expectedRevision?: number): Promise<SetupDraft>;
  /** Available only when the embedding supports a private, first-run connector setup checkpoint. */
  discardSetupDraft?(expectedRevision: number): Promise<void>;
  /** Available only when the embedding supports first-run selected local stdio entry import. */
  onboardClientEntry?(request: ConsoleClientEntryOnboardingRequest): Promise<ConsolePresetOnboardingReport>;
  /** Available only when the embedding supports endpoint-first native OAuth discovery. */
  onboardDiscoveredNativeOAuth?(
    request: ConsoleDiscoveredNativeOAuthOnboardingRequest
  ): Promise<ConsoleConnectionAddReport>;
  /** Available when an initialized configuration supports an endpoint-first OAuth connection. */
  addDiscoveredNativeOAuthConnection?(
    request: ConsoleDiscoveredNativeOAuthConnectionRequest
  ): Promise<ConsoleConnectionAddReport>;
  /** Available when an initialized configuration supports adding another endpoint-discovered OAuth account. */
  addDiscoveredNativeOAuthAccount?(
    request: ConsoleDiscoveredNativeOAuthAccountRequest
  ): Promise<ConsoleConnectionAddReport>;
  /** Available when an initialized configuration supports a reviewed provider-owned account addition. */
  addProviderAccount?(
    request: ConsoleProviderAccountAdditionRequest
  ): Promise<ConsoleProviderAccountAdditionReport>;
  /** Available when an initialized local stdio configuration has one safe static credential binding. */
  addEnvironmentProfile?(
    request: ConsoleEnvironmentProfileAdditionRequest
  ): Promise<ConsoleEnvironmentProfileAdditionReport>;
  /** Available when an initialized configuration has an existing profile to make durable. */
  setDefaultProfile?(
    request: ConsoleDefaultProfileChangeRequest
  ): Promise<ConsoleDefaultProfileChangeReport>;
  /** Available when an initialized configuration has an existing profile label to change. */
  setProfileDescription?(
    request: ConsoleProfileDescriptionChangeRequest
  ): Promise<ConsoleProfileDescriptionChangeReport>;
  /** Available when an initialized configuration has more than one removable profile. */
  removeProfile?(request: ConsoleProfileRemovalRequest): Promise<ConsoleProfileRemovalReport>;
  /** Available when an initialized configuration has an existing profile to rename. */
  renameProfile?(request: ConsoleProfileRenameRequest): Promise<ConsoleProfileRenameReport>;
  onboardNativeOAuth(request: ConsoleNativeOAuthOnboardingRequest): Promise<ConsoleConnectionAddReport>;
  clientSnippets(selection: ClientSelection): Promise<readonly ClientSnippet[]>;
  listConnections(): Promise<unknown>;
  connectionStatus(connectionRef: string): Promise<unknown>;
  addConnection(request: ConsoleConnectionAddRequest): Promise<ConsoleConnectionAddReport>;
  connect(connectionRef: string): Promise<unknown>;
  reauth(connectionRef: string): Promise<unknown>;
  testConnection(connectionRef: string): Promise<unknown>;
  disconnect(connectionRef: string): Promise<unknown>;
  /** Runs exactly one provider-declared safe read-only readiness call for a selected profile. */
  profileReadiness?(request: ConsoleProfileReadinessRequest): Promise<ProfileReadinessReport>;
  auditRecords(limit: number): Promise<readonly ConsoleAuditRecord[]>;
}

interface ConsoleOAuthCommandService {
  list(): Promise<unknown>;
  status(selector: { readonly connectionRef: string }): Promise<unknown>;
  connect(selector: { readonly connectionRef: string }): Promise<unknown>;
  reauth(selector: { readonly connectionRef: string }): Promise<unknown>;
  test(selector: { readonly connectionRef: string }): Promise<unknown>;
  disconnect(selector: { readonly connectionRef: string }): Promise<unknown>;
}

export interface ConsoleApplicationDependencies {
  readonly commandService?: ConsoleOAuthCommandService;
  readonly generateConnectionRef?: () => string;
  readonly launcher?: ClientLauncher;
  /** Internal test/runtime seam; endpoint-first discovery is guarded and never persists credentials. */
  readonly nativeOAuthFetch?: FetchLike;
  /** Internal test/runtime seam; production defaults to the exact OS vault and local OAuth metadata store. */
  readonly oauthProfileRename?: OAuthProfileRenameDependencies;
  /** A selected dashboard entry that was read through the catalog's verified file handle. */
  readonly trustedConfiguration?: ConsoleTrustedConfiguration;
}

function fileErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function configFromMigrationSource(source: ConfigMigrationSource): MiftahConfig {
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.originalBytes));
  } catch {
    throw new MiftahError("CONFIG_INVALID_JSON", "CONFIG_INVALID_JSON: configuration is not valid JSON");
  }
  return planConfigMigration(input).config as MiftahConfig;
}

function selectedNativeOAuthUpstream(
  config: MiftahConfig,
  profile: string,
  upstream: string
): ReturnType<typeof selectedExistingUpstream> {
  if (!Object.hasOwn(config.profiles, profile)) {
    throw new MiftahError("PROFILE_NOT_FOUND", "PROFILE_NOT_FOUND: profile does not exist");
  }
  return selectedExistingUpstream(config, upstream);
}

export function consoleAuditPath(configPath: string): string {
  return join(dirname(resolvePath(configPath)), ".miftah", "audit", "console.jsonl");
}

async function ensureFirstRunConfigDirectory(configPath: string): Promise<void> {
  const directory = dirname(resolvePath(configPath));
  try {
    if (process.platform !== "win32") {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return;
    }
    const parent = dirname(directory);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const created = await createWindowsPrivateDirectoryInPrivateParent(parent, directory);
    // The private writer holds the complete verified directory chain through
    // the exclusive first-file creation. A failed exclusive create may be a
    // safe concurrent Miftah creation, so both path components need an
    // independent verifier before that race is accepted.
    if (!created && !(await verifyWindowsConfigPathsSecurity([
      { path: parent, kind: "directory" },
      { path: directory, kind: "directory" }
    ]))) {
      throw new Error("unsafe configuration directory or parent");
    }
  } catch (error) {
    if (error instanceof MiftahError) throw error;
    throw new MiftahError(
      "CONFIG_CREATE_FAILED",
      "CONFIG_CREATE_FAILED: unable to create a safe first-run configuration directory",
      { cause: error }
    );
  }
}

function safeAuditRecord(value: unknown): ConsoleAuditRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const key of ["timestamp", "kind", "operation", "name", "profile", "upstream", "status", "errorCode"] as const) {
    if (typeof input[key] === "string") output[key] = input[key];
  }
  return output;
}

function firstRunSetupCompletion(config: MiftahConfig): SetupCompletion {
  const metadata = consoleInitializedConfigMetadata(config);
  const hasDeclaredSafeCheck = (metadata.authentication?.readinessTargets?.length ?? 0) > 0;
  const environment = inspectConfigEnvironment(config);
  return createSetupCompletion({
    surface: "console",
    verification: hasDeclaredSafeCheck ? "available" : "not-declared",
    clientHandoff: "available",
    ...(environment.state === "not-required"
      ? {}
      : { environment })
  });
}

/** Builds the exact validated first-run preset configuration for review or publication. */
function buildConsolePresetConfiguration(request: ConsolePresetOnboardingRequest, configPath: string): MiftahConfig {
  try {
    const config = buildPresetConfig(request.name, request.preset, {
      credentialEnv: request.credentialEnv,
      npmPackage: request.npmPackage,
      dockerImage: request.dockerImage,
      url: request.url,
      headerName: request.headerName,
      headerPrefix: request.headerPrefix,
      oauthClientSecretsFile: request.oauthClientSecretsFile,
      localCommand: request.localCommand,
      args: request.args,
      cwd: request.cwd,
      acceptLocalCommand: request.acceptLocalCommand,
      googleSearchConsoleProfiles: request.googleSearchConsoleProfiles,
      defaultProfile: request.defaultProfile
    }, {
      configurationPath: resolvePath(configPath)
    });
    return validateConfig(config);
  } catch (error) {
    if (error instanceof PresetCatalogError) {
      throw new MiftahError(
        "CONFIG_SCHEMA_INVALID",
        isWindowsNpxPresetUnavailable(request.preset)
          ? "CONFIG_SCHEMA_INVALID: the selected npm package-runner connector is unavailable on Windows; choose a direct .exe or .com executable, a direct-executable preset, or a remote MCP."
          : "CONFIG_SCHEMA_INVALID: the requested setup connector is not valid"
      );
    }
    throw error;
  }
}

class ConsoleConnectionAuditSink implements ConnectionApplicationAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  record(event: ConnectionApplicationAuditEvent): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/oauth-connection-add",
      name: "connection",
      profile: event.profile,
      upstream: event.upstream,
      status: event.status
    });
  }
}

class ConsoleNativeOAuthAccountAuditSink implements NativeOAuthAccountAdditionAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  record(event: { readonly profile: string; readonly upstream: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/oauth-profile-add",
      name: "profile",
      profile: event.profile,
      upstream: event.upstream,
      status: event.status
    });
  }
}

class ConsoleProviderAccountAuditSink implements ProviderAccountAdditionAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/provider-profile-add-intent",
      name: "profile",
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/provider-profile-add",
      name: "profile",
      profile: event.profile,
      status: event.status
    });
  }
}

class ConsoleEnvironmentProfileAuditSink implements EnvironmentProfileAdditionAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/environment-profile-add-intent",
      name: "profile",
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/environment-profile-add",
      name: "profile",
      profile: event.profile,
      status: event.status
    });
  }
}

class ConsoleDefaultProfileAuditSink implements DefaultProfileChangeAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/default-profile-set-intent",
      name: "profile",
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/default-profile-set",
      name: "profile",
      profile: event.profile,
      status: event.status
    });
  }
}

class ConsoleProfileDescriptionAuditSink implements ProfileDescriptionChangeAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string; readonly cleared: boolean }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/profile-description-set-intent",
      name: event.cleared ? "profile description clear" : "profile description set",
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly cleared: boolean; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/profile-description-set",
      name: event.cleared ? "profile description clear" : "profile description set",
      profile: event.profile,
      status: event.status
    });
  }
}

class ConsoleProfileRemovalAuditSink implements ProfileRemovalAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/profile-remove-intent",
      name: "profile",
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/profile-remove",
      name: "profile",
      profile: event.profile,
      status: event.status
    });
  }
}

class ConsoleProfileRenameAuditSink implements ProfileRenameAuditSink {
  constructor(private readonly trail: AuditTrail) {}

  ensureWritable(): Promise<void> {
    return this.trail.ensureWritable();
  }

  intent(event: { readonly profile: string; readonly newProfile: string }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/profile-rename-intent",
      name: event.newProfile,
      profile: event.profile,
      status: "success"
    });
  }

  record(event: { readonly profile: string; readonly newProfile: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/profile-rename",
      name: event.newProfile,
      profile: event.profile,
      status: event.status
    });
  }

  recordRecovered(event: { readonly profile: string; readonly newProfile: string; readonly status: "success" }): Promise<void> {
    return this.trail.writeRequiredLifecycle({
      operation: "console/profile-rename-recovered",
      name: event.newProfile,
      profile: event.profile,
      status: event.status
    });
  }
}

/** Shared, in-process Console application layer. It never invokes the Miftah CLI. */
export class ConsoleApplicationService implements ConsoleControlApplication {
  private readonly auditPath: string;
  private readonly audit: AuditTrail;

  private readonly commandService: ConsoleOAuthCommandService;
  private readonly generateConnectionRef: () => string;
  private readonly launcher: ClientLauncher | undefined;
  private readonly nativeOAuthFetch: FetchLike | undefined;
  private readonly oauthProfileRename: OAuthProfileRenameDependencies | undefined;
  private readonly trustedConfiguration: ConsoleTrustedConfiguration | undefined;

  constructor(
    private readonly configPath: string,
    dependencies: ConsoleApplicationDependencies = {}
  ) {
    this.auditPath = consoleAuditPath(configPath);
    this.audit = new AuditTrail("miftah-console", new AuditLogger(this.auditPath, { failureMode: "fail-closed" }));
    this.trustedConfiguration = dependencies.trustedConfiguration;
    this.commandService = dependencies.commandService ?? new OAuthConnectionCommandService(
      configPath,
      new NativeOAuthCommandRuntimeFactory(this.trustedConfiguration?.config)
    );
    this.generateConnectionRef = dependencies.generateConnectionRef ?? randomUUID;
    this.launcher = dependencies.launcher;
    this.nativeOAuthFetch = dependencies.nativeOAuthFetch;
    this.oauthProfileRename = dependencies.oauthProfileRename;
  }

  async health(): Promise<ConsoleHealth> {
    const config = await this.config();
    const audit = this.audit.health();
    return {
      status: "ok",
      config: { name: config.name, version: config.version },
      audit: {
        enabled: audit.enabled,
        ...(audit.state === undefined ? {} : { state: audit.state }),
        ...(audit.lastFailure === undefined
          ? {}
          : { lastFailure: { timestamp: audit.lastFailure.timestamp, errorCode: audit.lastFailure.errorCode } })
      },
      restartRequiredForExistingClients: true
    };
  }

  async configMetadata(): Promise<ConsoleConfigMetadata> {
    let config: Awaited<ReturnType<typeof loadConfig>>;
    try {
      config = await this.config();
    } catch (error) {
      if (error instanceof MiftahError && error.code === "CONFIG_NOT_FOUND") {
        return { initialized: false, restartRequiredForExistingClients: true };
      }
      throw error;
    }
    return consoleInitializedConfigMetadata(config);
  }

  async onboardNativeOAuth(
    request: ConsoleNativeOAuthOnboardingRequest
  ): Promise<ConsoleFirstRunNativeOAuthOnboardingReport> {
    const connectionRef = parseOAuthConnectionRef(`oauthconn:${this.generateConnectionRef()}`);
    const profile = {
      ...(request.description === undefined || request.description.length === 0
        ? {}
        : { description: request.description })
    };
    const config: MiftahConfig = {
      version: "3",
      name: request.name,
      defaultProfile: request.profile,
      upstream: { transport: "streamable-http", url: request.resource },
      profiles: { [request.profile]: profile },
      oauth: {
        connections: {
          [connectionRef]: {
            profile: request.profile,
            upstream: "default",
            resource: request.resource,
            issuer: request.issuer,
            clientRegistration: request.clientRegistration,
            scopes: [...request.scopes]
          }
        }
      }
    };
    validateConfig(config);
    await this.publishFirstRunConfiguration(config, {
      operation: "console/onboard-native-oauth",
      name: "connection",
      profile: request.profile,
      upstream: "default",
      status: "success"
    });
    return {
      changed: true,
      write: true,
      connectionRef,
      profile: request.profile,
      upstream: "default",
      resource: request.resource,
      actions: [
        `Created profile '${request.profile}'.`,
        `Added OAuth connection for profile '${request.profile}' and upstream 'default'.`
      ],
      completion: createSetupCompletion({
        surface: "console",
        verification: "authorization-pending",
        clientHandoff: "available"
      })
    };
  }

  async onboardDiscoveredNativeOAuth(
    request: ConsoleDiscoveredNativeOAuthOnboardingRequest
  ): Promise<ConsoleFirstRunNativeOAuthOnboardingReport> {
    const plan = await planNativeOAuthFirstRunConfiguration(request, {
      generateConnectionRef: this.generateConnectionRef,
      ...(this.nativeOAuthFetch === undefined ? {} : { fetch: this.nativeOAuthFetch })
    });
    await this.publishFirstRunConfiguration(plan.config, {
      operation: "console/onboard-native-oauth",
      name: "connection",
      profile: request.profile,
      upstream: "default",
      status: "success"
    });
    return {
      changed: true,
      write: true,
      connectionRef: plan.connectionRef,
      profile: request.profile,
      upstream: "default",
      resource: plan.discovery.resource,
      actions: [...plan.actions],
      completion: createSetupCompletion({
        surface: "console",
        verification: "authorization-pending",
        clientHandoff: "available"
      })
    };
  }

  async previewPreset(request: ConsolePresetOnboardingRequest): Promise<ConsolePresetOnboardingPreview> {
    const config = buildConsolePresetConfiguration(request, this.configPath);
    return {
      changed: false,
      write: false,
      name: config.name,
      defaultProfile: config.defaultProfile,
      profileCount: Object.keys(config.profiles).length,
      actions: [`Review Miftah configuration '${config.name}' from preset '${request.preset}' before creating it.`],
      configuration: describeSetupConfiguration(config)
    };
  }

  async onboardPreset(request: ConsolePresetOnboardingRequest): Promise<ConsolePresetOnboardingReport> {
    const config = buildConsolePresetConfiguration(request, this.configPath);
    await this.publishFirstRunConfiguration(config, {
      operation: "console/onboard-preset",
      name: "configuration",
      profile: config.defaultProfile,
      upstream: "default",
      status: "success"
    });
    return {
      changed: true,
      write: true,
      name: config.name,
      defaultProfile: config.defaultProfile,
      profileCount: Object.keys(config.profiles).length,
      actions: [`Created Miftah configuration '${config.name}' from preset '${request.preset}'.`],
      completion: firstRunSetupCompletion(config)
    };
  }

  async onboardClientEntry(request: ConsoleClientEntryOnboardingRequest): Promise<ConsolePresetOnboardingReport> {
    let config: MiftahConfig;
    try {
      config = createImportedClientConfiguration({
        configurationName: request.name,
        document: request.document,
        entry: request.entry
      });
    } catch (error) {
      if (error instanceof ClientEntryImportError) {
        if (error.reason === "static-launch") {
          throw new MiftahError(
            "CLIENT_ENTRY_STATIC_LAUNCH_UNSUPPORTED",
            "CLIENT_ENTRY_STATIC_LAUNCH_UNSUPPORTED: use advanced manual setup for custom arguments or credentials"
          );
        }
        throw new MiftahError(
          "CONFIG_SCHEMA_INVALID",
          "CONFIG_SCHEMA_INVALID: the selected client entry cannot be imported safely"
        );
      }
      throw error;
    }
    await this.publishFirstRunConfiguration(config, {
      operation: "console/onboard-client-entry",
      name: "configuration",
      profile: config.defaultProfile,
      upstream: "default",
      status: "success"
    });
    return {
      changed: true,
      write: true,
      name: config.name,
      defaultProfile: config.defaultProfile,
      profileCount: Object.keys(config.profiles).length,
      actions: [
        config.upstream?.transport === "streamable-http"
          ? `Created Miftah configuration '${config.name}' from one selected HTTPS remote client entry without OAuth discovery or an upstream call.`
          : `Created Miftah configuration '${config.name}' from one selected local stdio client entry.`
      ],
      completion: firstRunSetupCompletion(config)
    };
  }

  async clientSnippets(selection: ClientSelection): Promise<readonly ClientSnippet[]> {
    if (this.launcher === undefined) {
      throw new MiftahError("CONSOLE_LAUNCHER_UNAVAILABLE", "CONSOLE_LAUNCHER_UNAVAILABLE: client snippets are unavailable");
    }
    const config = await this.config();
    return renderClientSnippets(selection, {
      serverName: config.name,
      configPath: resolvePath(this.configPath),
      launcher: this.launcher,
      requiredEnvironmentVariables: environmentReferencesFromConfig(config),
      environmentFilesConfigured: (config.secrets?.envFiles?.length ?? 0) > 0
    });
  }

  async listConnections(): Promise<unknown> {
    try {
      return await this.commandService.list();
    } catch (error) {
      if (!(error instanceof MiftahError)) throw error;
      const configured = await new NativeOAuthCommandRuntimeFactory(this.trustedConfiguration?.config).connections(this.configPath);
      return configured.map((connection) => ({
        ...connection,
        credentialState: "unsupported",
        identityState: "unavailable",
        statusErrorCode: error.code
      }));
    }
  }

  connectionStatus(connectionRef: string): Promise<unknown> {
    return this.commandService.status({ connectionRef });
  }

  async addConnection(request: ConsoleConnectionAddRequest): Promise<ConsoleConnectionAddReport> {
    const result = await runConnectionAddCommand({
      configPath: this.configPath,
      connectionRef: request.connectionRef,
      profile: request.profile,
      upstream: request.upstream,
      issuer: request.issuer,
      clientRegistration: request.clientRegistration,
      scopes: request.scopes,
      write: true
    }, {
      audit: new ConsoleConnectionAuditSink(this.audit),
      ...(this.trustedConfiguration === undefined ? {} : { trustedSource: this.trustedConfiguration.migrationSource })
    });
    return {
      changed: result.changed,
      write: result.write,
      connectionRef: result.connectionRef,
      profile: result.profile,
      upstream: result.upstream,
      resource: result.resource,
      actions: result.actions
    };
  }

  async addDiscoveredNativeOAuthConnection(
    request: ConsoleDiscoveredNativeOAuthConnectionRequest
  ): Promise<ConsoleConnectionAddReport> {
    const configPath = resolvePath(this.configPath);
    const source = this.trustedConfiguration?.migrationSource ?? await readConfigMigrationSource(configPath);
    const config = this.trustedConfiguration?.config ?? configFromMigrationSource(source);
    const selected = selectedNativeOAuthUpstream(config, request.profile, request.upstream);
    const connectionRef = parseOAuthConnectionRef(`oauthconn:${this.generateConnectionRef()}`);
    const discovery = await discoverNativeOAuthConnection({
      resource: selected.config.url,
      profile: request.profile,
      upstream: selected.name,
      connectionRef
    }, {
      ...(this.nativeOAuthFetch === undefined ? {} : { fetch: this.nativeOAuthFetch })
    });
    const result = await runConnectionAddCommand({
      configPath,
      connectionRef,
      profile: request.profile,
      upstream: selected.name,
      issuer: discovery.issuer,
      clientRegistration: discovery.clientRegistration,
      scopes: discovery.advertisedScopes,
      write: true
    }, {
      audit: new ConsoleConnectionAuditSink(this.audit),
      trustedSource: source
    });
    return {
      changed: result.changed,
      write: result.write,
      connectionRef: result.connectionRef,
      profile: result.profile,
      upstream: result.upstream,
      resource: result.resource,
      actions: result.actions
    };
  }

  async addDiscoveredNativeOAuthAccount(
    request: ConsoleDiscoveredNativeOAuthAccountRequest
  ): Promise<ConsoleConnectionAddReport> {
    const configPath = resolvePath(this.configPath);
    const source = this.trustedConfiguration?.migrationSource ?? await readConfigMigrationSource(configPath);
    const result = await runNativeOAuthAccountAddition({
      configPath,
      profile: request.profile,
      ...(request.description === undefined ? {} : { description: request.description }),
      upstream: request.upstream,
      ...(request.makeDefault === true ? { makeDefault: true } : {})
    }, {
      generateConnectionRef: this.generateConnectionRef,
      ...(this.nativeOAuthFetch === undefined ? {} : { fetch: this.nativeOAuthFetch }),
      trustedSource: source,
      audit: new ConsoleNativeOAuthAccountAuditSink(this.audit)
    });
    return {
      changed: result.changed,
      write: result.write,
      connectionRef: result.connectionRef,
      profile: result.profile,
      upstream: result.upstream,
      resource: result.resource,
      actions: result.actions
    };
  }

  async addProviderAccount(
    request: ConsoleProviderAccountAdditionRequest
  ): Promise<ConsoleProviderAccountAdditionReport> {
    const configPath = resolvePath(this.configPath);
    const source = this.trustedConfiguration?.migrationSource ?? await readConfigMigrationSource(configPath);
    const result = await runProviderAccountAddition({
      configPath,
      profile: request.profile,
      ...(request.description === undefined ? {} : { description: request.description }),
      credentialFile: request.credentialFile,
      ...(request.makeDefault === true ? { makeDefault: true } : {})
    }, {
      trustedSource: source,
      audit: new ConsoleProviderAccountAuditSink(this.audit)
    });
    return {
      changed: result.changed,
      write: result.write,
      adapter: result.adapter,
      profile: result.profile,
      actions: result.actions
    };
  }

  async addEnvironmentProfile(
    request: ConsoleEnvironmentProfileAdditionRequest
  ): Promise<ConsoleEnvironmentProfileAdditionReport> {
    const configPath = resolvePath(this.configPath);
    const source = this.trustedConfiguration?.migrationSource ?? await readConfigMigrationSource(configPath);
    const result = await runEnvironmentProfileAddition({
      configPath,
      profile: request.profile,
      ...(request.description === undefined ? {} : { description: request.description }),
      credentialEnv: request.credentialEnv,
      ...(request.makeDefault === true ? { makeDefault: true } : {})
    }, {
      trustedSource: source,
      audit: new ConsoleEnvironmentProfileAuditSink(this.audit)
    });
    return {
      changed: result.changed,
      write: result.write,
      profile: result.profile,
      actions: result.actions
    };
  }

  async setDefaultProfile(
    request: ConsoleDefaultProfileChangeRequest
  ): Promise<ConsoleDefaultProfileChangeReport> {
    const configPath = resolvePath(this.configPath);
    const source = this.trustedConfiguration?.migrationSource ?? await readConfigMigrationSource(configPath);
    const result = await runDefaultProfileChange({ configPath, profile: request.profile }, {
      trustedSource: source,
      audit: new ConsoleDefaultProfileAuditSink(this.audit)
    });
    return {
      changed: result.changed,
      write: result.write,
      profile: result.profile,
      actions: result.actions
    };
  }

  async setProfileDescription(
    request: ConsoleProfileDescriptionChangeRequest
  ): Promise<ConsoleProfileDescriptionChangeReport> {
    const configPath = resolvePath(this.configPath);
    const source = this.trustedConfiguration?.migrationSource ?? await readConfigMigrationSource(configPath);
    const result = await runProfileDescriptionChange({
      configPath,
      profile: request.profile,
      ...(request.description === undefined ? {} : { description: request.description }),
      ...(request.clearDescription === true ? { clearDescription: true } : {})
    }, {
      trustedSource: source,
      audit: new ConsoleProfileDescriptionAuditSink(this.audit)
    });
    return {
      changed: result.changed,
      write: result.write,
      profile: result.profile,
      actions: result.actions
    };
  }

  async removeProfile(request: ConsoleProfileRemovalRequest): Promise<ConsoleProfileRemovalReport> {
    const configPath = resolvePath(this.configPath);
    const source = this.trustedConfiguration?.migrationSource ?? await readConfigMigrationSource(configPath);
    const result = await runProfileRemoval({
      configPath,
      profile: request.profile,
      ...(request.replacementProfile === undefined ? {} : { replacementProfile: request.replacementProfile })
    }, {
      trustedSource: source,
      audit: new ConsoleProfileRemovalAuditSink(this.audit)
    });
    return {
      changed: result.changed,
      write: result.write,
      profile: result.profile,
      ...(result.replacementProfile === undefined ? {} : { replacementProfile: result.replacementProfile }),
      actions: result.actions
    };
  }

  async renameProfile(request: ConsoleProfileRenameRequest): Promise<ConsoleProfileRenameReport> {
    const configPath = resolvePath(this.configPath);
    const source = this.trustedConfiguration?.migrationSource ?? await readConfigMigrationSource(configPath);
    const result = await runProfileRename({
      configPath,
      profile: request.profile,
      newProfile: request.newProfile
    }, {
      trustedSource: source,
      audit: new ConsoleProfileRenameAuditSink(this.audit),
      ...(this.oauthProfileRename === undefined ? {} : { oauth: this.oauthProfileRename })
    });
    return {
      changed: result.changed,
      write: result.write,
      profile: result.profile,
      newProfile: result.newProfile,
      actions: result.actions
    };
  }

  connect(connectionRef: string): Promise<unknown> {
    return this.runConnectionMutation(connectionRef, "connect", (service) => service.connect({ connectionRef }));
  }

  reauth(connectionRef: string): Promise<unknown> {
    return this.runConnectionMutation(connectionRef, "reauth", (service) => service.reauth({ connectionRef }));
  }

  testConnection(connectionRef: string): Promise<unknown> {
    return this.runConnectionMutation(connectionRef, "test", (service) => service.test({ connectionRef }));
  }

  disconnect(connectionRef: string): Promise<unknown> {
    return this.runConnectionMutation(connectionRef, "disconnect", (service) => service.disconnect({ connectionRef }));
  }

  async profileReadiness(request: ConsoleProfileReadinessRequest): Promise<ProfileReadinessReport> {
    const config = await this.config();
    await this.audit.ensureWritable();
    try {
      const report = await runProfileReadinessFromLoadedConfig(this.configPath, config, request);
      const errorCode = readinessErrorCode(report);
      await this.audit.writeRequiredLifecycle({
        operation: "console/profile-readiness",
        name: "profile",
        profile: request.profile,
        upstream: report.upstream,
        status: readinessAuditStatus(report),
        ...(errorCode === undefined ? {} : { errorCode })
      });
      return report;
    } catch (error) {
      const errorCode = error instanceof MiftahError ? error.code : "UPSTREAM_CALL_FAILED";
      await this.audit.writeRequiredLifecycle({
        operation: "console/profile-readiness",
        name: "profile",
        profile: request.profile,
        ...(request.upstream === undefined ? {} : { upstream: request.upstream }),
        status: "failure",
        errorCode
      });
      throw error;
    }
  }

  private async config(): Promise<MiftahConfig> {
    return this.trustedConfiguration?.config ?? loadConfig(this.configPath);
  }

  private async publishFirstRunConfiguration(
    config: MiftahConfig,
    audit: Pick<AuditLifecycleInput, "operation" | "name" | "profile" | "upstream" | "status">
  ): Promise<void> {
    const setup = createSetupConfigurationPlan({ configPath: this.configPath, config });
    await ensureFirstRunConfigDirectory(setup.path);
    await this.audit.ensureWritable();
    try {
      await publishFirstRunSetupConfigurationPlan(setup);
    } catch (error) {
      if (fileErrorCode(error) === "EEXIST") {
        throw new MiftahError(
          "CONFIG_ALREADY_EXISTS",
          "CONFIG_ALREADY_EXISTS: refusing to replace an existing configuration"
        );
      }
      throw new MiftahError(
        "CONFIG_CREATE_FAILED",
        "CONFIG_CREATE_FAILED: unable to create the initial configuration"
      );
    }
    await this.audit.writeRequiredLifecycle(audit);
  }

  private async runConnectionMutation(
    connectionRef: string,
    action: "connect" | "reauth" | "test" | "disconnect",
    operation: (service: ConsoleOAuthCommandService) => Promise<unknown>
  ): Promise<unknown> {
    const reference = parseOAuthConnectionRef(connectionRef);
    const config = await this.config();
    const target = config.version === "3" ? config.oauth?.connections[reference] : undefined;
    if (target === undefined) {
      throw new MiftahError("OAUTH_CONNECTION_NOT_FOUND", "OAUTH_CONNECTION_NOT_FOUND: OAuth connection does not exist");
    }
    await this.audit.ensureWritable();
    try {
      const result = await operation(this.commandService);
      await this.audit.writeRequiredLifecycle({
        operation: `console/oauth-${action}`,
        name: "connection",
        profile: target.profile,
        upstream: target.upstream,
        status: "success"
      });
      return result;
    } catch (error) {
      const errorCode = error instanceof MiftahError ? error.code : "OAUTH_AUTHORIZATION_FAILED";
      await this.audit.writeRequiredLifecycle({
        operation: `console/oauth-${action}`,
        name: "connection",
        profile: target.profile,
        upstream: target.upstream,
        status: "failure",
        errorCode
      });
      throw error;
    }
  }

  async auditRecords(limit: number): Promise<readonly ConsoleAuditRecord[]> {
    let pending = "";
    const records: ConsoleAuditRecord[] = [];
    try {
      await readAuditJsonl({
        path: this.auditPath,
        redactor: new SecretRedactor(),
        includeArguments: false,
        write: (chunk) => {
          pending += chunk;
          let newline = pending.indexOf("\n");
          while (newline !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (line.length > 0) {
              try {
                const record = safeAuditRecord(JSON.parse(line));
                if (record !== undefined) records.push(record);
              } catch {
                // The hardened reader emits a fixed malformed-record marker; it has no metadata to expose.
              }
            }
            newline = pending.indexOf("\n");
          }
        }
      });
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    }
    return records.slice(-limit);
  }
}

function readinessAuditStatus(report: ProfileReadinessReport): "success" | "failure" | "blocked" | "confirmation-required" {
  if (report.status === "ready") return "success";
  if (report.status === "blocked") return "blocked";
  if (report.status === "confirmation-required") return "confirmation-required";
  return "failure";
}

function readinessErrorCode(report: ProfileReadinessReport): string | undefined {
  return report.safeRead.errorCode ?? report.identity.errorCode;
}
