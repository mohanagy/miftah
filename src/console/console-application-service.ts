import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readAuditJsonl } from "../cli/audit-jsonl.js";
import { resolvePath } from "../config/path-resolve.js";
import { buildPresetConfig, PresetCatalogError } from "../config/presets.js";
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
import {
  createSetupConfigurationPlan,
  publishSetupConfigurationPlan
} from "../setup/setup-configuration.js";
import {
  runProfileReadinessFromLoadedConfig,
  type ProfileReadinessReport
} from "../setup/profile-readiness.js";
import {
  createWindowsPrivateDirectory,
  verifyWindowsConfigPathSecurity
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

export type ConsoleConnectionAddReport = Omit<ConnectionAddCommandReport, "backupPath">;

export interface ConsoleNativeOAuthOnboardingRequest {
  readonly name: string;
  readonly profile: string;
  readonly description?: string;
  readonly resource: string;
  readonly issuer: string;
  readonly clientRegistration: string;
  readonly scopes: readonly string[];
}

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
  onboardPreset?(request: ConsolePresetOnboardingRequest): Promise<ConsolePresetOnboardingReport>;
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
  /** A selected dashboard entry that was read through the catalog's verified file handle. */
  readonly trustedConfiguration?: ConsoleTrustedConfiguration;
}

function fileErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function consoleAuditPath(configPath: string): string {
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
    if (!(await verifyWindowsConfigPathSecurity(parent, "directory"))) {
      throw new Error("unsafe configuration parent directory");
    }
    await createWindowsPrivateDirectory(directory);
    if (!(await verifyWindowsConfigPathSecurity(directory, "directory"))) {
      throw new Error("unsafe configuration directory");
    }
  } catch (error) {
    if (error instanceof MiftahError) throw error;
    throw new MiftahError(
      "CONFIG_CREATE_FAILED",
      "CONFIG_CREATE_FAILED: unable to create a safe first-run configuration directory"
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

/** Shared, in-process Console application layer. It never invokes the Miftah CLI. */
export class ConsoleApplicationService implements ConsoleControlApplication {
  private readonly auditPath: string;
  private readonly audit: AuditTrail;

  private readonly commandService: ConsoleOAuthCommandService;
  private readonly generateConnectionRef: () => string;
  private readonly launcher: ClientLauncher | undefined;
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

  async onboardNativeOAuth(request: ConsoleNativeOAuthOnboardingRequest): Promise<ConsoleConnectionAddReport> {
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
      ]
    };
  }

  async onboardPreset(request: ConsolePresetOnboardingRequest): Promise<ConsolePresetOnboardingReport> {
    let config: MiftahConfig;
    try {
      config = buildPresetConfig(request.name, request.preset, {
        credentialEnv: request.credentialEnv,
        npmPackage: request.npmPackage,
        dockerImage: request.dockerImage,
        url: request.url,
        headerName: request.headerName,
        headerPrefix: request.headerPrefix,
        oauthClientSecretsFile: request.oauthClientSecretsFile,
        googleSearchConsoleProfiles: request.googleSearchConsoleProfiles,
        defaultProfile: request.defaultProfile
      }, {
        configurationPath: resolvePath(this.configPath)
      });
      validateConfig(config);
    } catch (error) {
      if (error instanceof PresetCatalogError) {
        throw new MiftahError("CONFIG_SCHEMA_INVALID", "CONFIG_SCHEMA_INVALID: the requested setup connector is not valid");
      }
      throw error;
    }
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
      actions: [`Created Miftah configuration '${config.name}' from preset '${request.preset}'.`]
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
      launcher: this.launcher
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
      await publishSetupConfigurationPlan(setup);
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
