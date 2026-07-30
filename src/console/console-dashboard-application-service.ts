import type { ClientLauncher, ClientSelection, ClientSnippet } from "../cli/client-snippets.js";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolvePath } from "../config/path-resolve.js";
import { MiftahError } from "../utils/errors.js";
import {
  ConsoleApplicationService,
  type ConsoleAuditRecord,
  type ConsoleClientEntryOnboardingRequest,
  type ConsoleConnectionAddReport,
  type ConsoleFirstRunNativeOAuthOnboardingReport,
  type ConsoleConnectionAddRequest,
  type ConsoleControlApplication,
  type ConsoleDefaultProfileChangeReport,
  type ConsoleDefaultProfileChangeRequest,
  type ConsoleProfileDescriptionChangeReport,
  type ConsoleProfileDescriptionChangeRequest,
  type ConsoleProfileRemovalReport,
  type ConsoleProfileRemovalRequest,
  type ConsoleProfileRenameReport,
  type ConsoleProfileRenameRequest,
  type ConsoleDiscoveredNativeOAuthAccountRequest,
  type ConsoleDiscoveredNativeOAuthConnectionRequest,
  type ConsoleDiscoveredNativeOAuthOnboardingRequest,
  type ConsoleEnvironmentProfileAdditionReport,
  type ConsoleEnvironmentProfileAdditionRequest,
  type ConsoleHealth,
  type ConsoleNativeOAuthOnboardingRequest,
  type ConsoleProfileReadinessRequest,
  type ConsoleProviderAccountAdditionRequest,
  type ConsoleProviderAccountAdditionReport,
  type ConsolePresetOnboardingPreview,
  type ConsolePresetOnboardingReport,
  type ConsolePresetOnboardingRequest
} from "./console-application-service.js";
import type { ProfileReadinessReport } from "../setup/profile-readiness.js";
import {
  discoverConsoleConfigCatalog,
  trustedConfigurationFor,
  trustedDirectoryFor,
  type ConsoleConfigCatalogDiscovery,
  type ConsoleTrustedCatalogDirectory,
  type DiscoveredConsoleConfiguration
} from "./console-config-catalog.js";
import type { ConsoleConfigCatalog, ConsoleConfigMetadata } from "./console-config-metadata.js";
import type { ConsoleTrustedConfiguration } from "./console-trusted-configuration.js";
import type { SetupDraft, SetupDraftInput, SetupDraftStore } from "../setup/setup-draft.js";

const returningConfigurationName = /^[a-z0-9](?:[a-z0-9._-]{0,63})?$/u;

function fileErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export interface ConsoleDashboardApplicationServiceOptions {
  /** Destination used only for a genuine first native OAuth configuration. */
  readonly defaultConfigPath: string;
  /** Bounded source of known configurations; client settings are never inspected. */
  readonly configDirectory: string;
  readonly launcher?: ClientLauncher;
  /** Internal test/runtime seam for guarded endpoint-first OAuth discovery. */
  readonly nativeOAuthFetch?: FetchLike;
  /** Shared private setup checkpoint store; omitted embeddings expose no draft controls. */
  readonly setupDraftStore?: SetupDraftStore;
}

interface ActiveConsoleConfiguration {
  readonly id: string;
  readonly contentDigest: string;
}

interface SelectedConsoleConfiguration {
  readonly configuration: DiscoveredConsoleConfiguration;
  readonly trustedConfiguration: ConsoleTrustedConfiguration;
}

interface SelectedConsoleApplication extends SelectedConsoleConfiguration {
  readonly application: ConsoleApplicationService;
}

function selectedCatalog(catalog: ConsoleConfigCatalog, selectedConfigurationId: string | undefined): ConsoleConfigCatalog {
  return {
    ...catalog,
    ...(selectedConfigurationId === undefined ? {} : { selectedConfigurationId })
  };
}

function withCatalog(metadata: ConsoleConfigMetadata, catalog: ConsoleConfigCatalog, selectedConfigurationId?: string): ConsoleConfigMetadata {
  return { ...metadata, catalog: selectedCatalog(catalog, selectedConfigurationId) };
}

/**
 * In-process dashboard selector for the bounded standard Miftah config directory.
 * It never opens MCP clients, edits their settings, or derives configuration from
 * process arguments. Explicit --config invocations continue to use ConsoleApplicationService directly.
 */
export class ConsoleDashboardApplicationService implements ConsoleControlApplication {
  private readonly firstRunApplication: ConsoleApplicationService;
  private readonly setupDraftStore: SetupDraftStore | undefined;
  readonly loadSetupDraft: (() => Promise<SetupDraft | undefined>) | undefined;
  readonly saveSetupDraft: ((input: SetupDraftInput, expectedRevision?: number) => Promise<SetupDraft>) | undefined;
  readonly discardSetupDraft: ((expectedRevision: number) => Promise<void>) | undefined;
  private active: ActiveConsoleConfiguration | undefined;
  // Only a revision returned by this dashboard instance is retained. The
  // store still revalidates it under its lock before deletion, preserving a
  // concurrent writer's conflict rather than deleting a newer draft.
  private knownSetupDraftRevision: number | undefined;
  private discoveryInFlight: Promise<ConsoleConfigCatalogDiscovery> | undefined;

  constructor(private readonly options: ConsoleDashboardApplicationServiceOptions) {
    this.firstRunApplication = this.applicationFor(options.defaultConfigPath);
    this.setupDraftStore = options.setupDraftStore;
    const store = this.setupDraftStore;
    if (store !== undefined) {
      this.loadSetupDraft = async () => {
        await this.assertFirstRunAvailable();
        const draft = await store.load();
        this.knownSetupDraftRevision = draft?.revision;
        return draft;
      };
      this.saveSetupDraft = async (input, expectedRevision) => {
        await this.assertFirstRunAvailable();
        const draft = await store.save(input, expectedRevision);
        this.knownSetupDraftRevision = draft.revision;
        return draft;
      };
      this.discardSetupDraft = async (expectedRevision) => {
        await this.assertFirstRunAvailable();
        await store.discard(expectedRevision);
        if (this.knownSetupDraftRevision === expectedRevision) this.knownSetupDraftRevision = undefined;
      };
    }
  }

  async configMetadata(): Promise<ConsoleConfigMetadata> {
    const discovered = await this.discover();
    const active = this.active;
    if (active === undefined) {
      return withCatalog(
        { initialized: false, restartRequiredForExistingClients: true },
        discovered.catalog
      );
    }
    const selected = this.selectedFrom(discovered);
    if (selected === undefined) {
      return withCatalog(
        { initialized: false, restartRequiredForExistingClients: true },
        discovered.catalog
      );
    }
    return withCatalog(selected.configuration.initializedMetadata, discovered.catalog, active.id);
  }

  async selectConfiguration(configurationId: string): Promise<ConsoleConfigMetadata> {
    const discovered = await this.discover();
    if (discovered.catalog.discoveryState !== "ready") {
      throw new MiftahError(
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE",
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE: the standard configuration directory could not be inspected safely"
      );
    }
    const selected = discovered.configurations.find((configuration) => configuration.metadata.id === configurationId);
    const trustedConfiguration = selected === undefined ? undefined : trustedConfigurationFor(selected);
    if (selected === undefined || trustedConfiguration === undefined) {
      throw new MiftahError(
        "CONSOLE_CONFIGURATION_NOT_FOUND",
        "CONSOLE_CONFIGURATION_NOT_FOUND: the selected configuration is not available"
      );
    }
    this.active = { id: selected.metadata.id, contentDigest: trustedConfiguration.contentDigest };
    return withCatalog(selected.initializedMetadata, discovered.catalog, selected.metadata.id);
  }

  async health(): Promise<ConsoleHealth> {
    return (await this.selectedApplication()).application.health();
  }

  async onboardNativeOAuth(
    request: ConsoleNativeOAuthOnboardingRequest
  ): Promise<ConsoleFirstRunNativeOAuthOnboardingReport> {
    const target = await this.setupTarget(request.name);
    const result = await target.application.onboardNativeOAuth({ ...request, name: target.name });
    await this.clearSetupDraftAfterFirstRunPublication();
    await this.confirmCreatedFirstRunConfiguration(target.path);
    return result;
  }

  async onboardDiscoveredNativeOAuth(
    request: ConsoleDiscoveredNativeOAuthOnboardingRequest
  ): Promise<ConsoleFirstRunNativeOAuthOnboardingReport> {
    const target = await this.setupTarget(request.name);
    const result = await target.application.onboardDiscoveredNativeOAuth({ ...request, name: target.name });
    await this.clearSetupDraftAfterFirstRunPublication();
    await this.confirmCreatedFirstRunConfiguration(target.path);
    return result;
  }

  async onboardPreset(request: ConsolePresetOnboardingRequest): Promise<ConsolePresetOnboardingReport> {
    const target = await this.setupTarget(request.name);
    const result = await target.application.onboardPreset({ ...request, name: target.name });
    await this.clearSetupDraftAfterFirstRunPublication();
    await this.confirmCreatedFirstRunConfiguration(target.path);
    return result;
  }

  async previewPreset(request: ConsolePresetOnboardingRequest): Promise<ConsolePresetOnboardingPreview> {
    const target = await this.setupTarget(request.name);
    return target.application.previewPreset({ ...request, name: target.name });
  }

  async onboardClientEntry(request: ConsoleClientEntryOnboardingRequest): Promise<ConsolePresetOnboardingReport> {
    const target = await this.setupTarget(request.name);
    const result = await target.application.onboardClientEntry({ ...request, name: target.name });
    await this.clearSetupDraftAfterFirstRunPublication();
    await this.confirmCreatedFirstRunConfiguration(target.path);
    return result;
  }

  async clientSnippets(selection: ClientSelection): Promise<readonly ClientSnippet[]> {
    return (await this.selectedApplication()).application.clientSnippets(selection);
  }

  async listConnections(): Promise<unknown> {
    return (await this.selectedApplication()).application.listConnections();
  }

  async connectionStatus(connectionRef: string): Promise<unknown> {
    return (await this.selectedApplication()).application.connectionStatus(connectionRef);
  }

  async addConnection(request: ConsoleConnectionAddRequest): Promise<ConsoleConnectionAddReport> {
    const selected = await this.selectedApplication();
    const result = await selected.application.addConnection(request);
    // Do not automatically bind a newly scanned pathname after mutation: another
    // writer could have replaced it between our guarded commit and a refresh.
    this.active = undefined;
    return result;
  }

  async addDiscoveredNativeOAuthConnection(
    request: ConsoleDiscoveredNativeOAuthConnectionRequest
  ): Promise<ConsoleConnectionAddReport> {
    const selected = await this.selectedApplication();
    const result = await selected.application.addDiscoveredNativeOAuthConnection(request);
    // The guarded commit changes the file contents; require a fresh explicit
    // selection instead of retaining a stale trusted snapshot.
    this.active = undefined;
    return result;
  }

  async addDiscoveredNativeOAuthAccount(
    request: ConsoleDiscoveredNativeOAuthAccountRequest
  ): Promise<ConsoleConnectionAddReport> {
    const selected = await this.selectedApplication();
    const result = await selected.application.addDiscoveredNativeOAuthAccount(request);
    // The guarded commit changes the file contents; require a fresh explicit
    // selection instead of retaining a stale trusted snapshot.
    this.active = undefined;
    return result;
  }

  async addProviderAccount(
    request: ConsoleProviderAccountAdditionRequest
  ): Promise<ConsoleProviderAccountAdditionReport> {
    const selected = await this.selectedApplication();
    const result = await selected.application.addProviderAccount(request);
    // The guarded commit changes the file contents; require a fresh explicit
    // selection instead of retaining a stale trusted snapshot.
    this.active = undefined;
    return result;
  }

  async addEnvironmentProfile(
    request: ConsoleEnvironmentProfileAdditionRequest
  ): Promise<ConsoleEnvironmentProfileAdditionReport> {
    const selected = await this.selectedApplication();
    const result = await selected.application.addEnvironmentProfile(request);
    // The guarded commit changes the file contents; require a fresh explicit
    // selection instead of retaining a stale trusted snapshot.
    this.active = undefined;
    return result;
  }

  async setDefaultProfile(
    request: ConsoleDefaultProfileChangeRequest
  ): Promise<ConsoleDefaultProfileChangeReport> {
    const selected = await this.selectedApplication();
    const result = await selected.application.setDefaultProfile(request);
    // A successful guarded write changes the configuration digest. Never let a
    // later Console operation reuse the pre-write trusted source snapshot.
    if (result.write) this.active = undefined;
    return result;
  }

  async setProfileDescription(
    request: ConsoleProfileDescriptionChangeRequest
  ): Promise<ConsoleProfileDescriptionChangeReport> {
    const selected = await this.selectedApplication();
    const result = await selected.application.setProfileDescription(request);
    // A successful guarded write changes the configuration digest. Never let a
    // later Console operation reuse the pre-write trusted source snapshot.
    if (result.write) this.active = undefined;
    return result;
  }

  async removeProfile(request: ConsoleProfileRemovalRequest): Promise<ConsoleProfileRemovalReport> {
    const selected = await this.selectedApplication();
    const result = await selected.application.removeProfile(request);
    // A successful guarded write changes the configuration digest. Never let a
    // later Console operation reuse the pre-write trusted source snapshot.
    if (result.write) this.active = undefined;
    return result;
  }

  async renameProfile(request: ConsoleProfileRenameRequest): Promise<ConsoleProfileRenameReport> {
    const selected = await this.selectedApplication();
    const result = await selected.application.renameProfile(request);
    // A successful guarded write changes the configuration digest. Never let a
    // later Console operation reuse the pre-write trusted source snapshot.
    if (result.write) this.active = undefined;
    return result;
  }

  async connect(connectionRef: string): Promise<unknown> {
    return (await this.selectedApplication()).application.connect(connectionRef);
  }

  async reauth(connectionRef: string): Promise<unknown> {
    return (await this.selectedApplication()).application.reauth(connectionRef);
  }

  async testConnection(connectionRef: string): Promise<unknown> {
    return (await this.selectedApplication()).application.testConnection(connectionRef);
  }

  async disconnect(connectionRef: string): Promise<unknown> {
    return (await this.selectedApplication()).application.disconnect(connectionRef);
  }

  async profileReadiness(request: ConsoleProfileReadinessRequest): Promise<ProfileReadinessReport> {
    return (await this.selectedApplication()).application.profileReadiness(request);
  }

  async auditRecords(limit: number): Promise<readonly ConsoleAuditRecord[]> {
    return (await this.selectedApplication()).application.auditRecords(limit);
  }

  private applicationFor(
    configPath: string,
    trustedConfiguration?: ConsoleTrustedConfiguration,
    trustedCreationDirectory?: ConsoleTrustedCatalogDirectory
  ): ConsoleApplicationService {
    return new ConsoleApplicationService(configPath, {
      ...(this.options.launcher === undefined ? {} : { launcher: this.options.launcher }),
      ...(this.options.nativeOAuthFetch === undefined ? {} : { nativeOAuthFetch: this.options.nativeOAuthFetch }),
      ...(trustedConfiguration === undefined ? {} : { trustedConfiguration }),
      ...(trustedCreationDirectory === undefined ? {} : { trustedCreationDirectory })
    });
  }

  private async selectedApplication(): Promise<SelectedConsoleApplication> {
    if (this.active === undefined) {
      throw new MiftahError(
        "CONSOLE_CONFIGURATION_SELECTION_REQUIRED",
        "CONSOLE_CONFIGURATION_SELECTION_REQUIRED: select a configuration before using Console controls"
      );
    }
    const discovered = await this.discover();
    if (discovered.catalog.discoveryState !== "ready") {
      throw new MiftahError(
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE",
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE: the standard configuration directory could not be inspected safely"
      );
    }
    const selected = this.selectedFrom(discovered);
    if (selected !== undefined) {
      return {
        ...selected,
        application: this.applicationFor(selected.configuration.path, selected.trustedConfiguration)
      };
    }
    throw new MiftahError(
      "CONSOLE_CONFIGURATION_SELECTION_REQUIRED",
      "CONSOLE_CONFIGURATION_SELECTION_REQUIRED: select a configuration before using Console controls"
    );
  }

  private async assertFirstRunAvailable(): Promise<void> {
    const discovered = await this.discover();
    if (discovered.catalog.discoveryState !== "ready") {
      throw new MiftahError(
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE",
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE: the standard configuration directory could not be inspected safely"
      );
    }
    if (discovered.configurations.length > 0) {
      throw new MiftahError(
        "CONSOLE_CONFIGURATION_SELECTION_REQUIRED",
        "CONSOLE_CONFIGURATION_SELECTION_REQUIRED: select an existing configuration before changing it"
      );
    }
  }

  private async clearSetupDraftAfterFirstRunPublication(): Promise<void> {
    const store = this.setupDraftStore;
    if (store === undefined) return;
    try {
      const knownRevision = this.knownSetupDraftRevision;
      if (knownRevision !== undefined) {
        await store.discard(knownRevision);
        this.knownSetupDraftRevision = undefined;
        return;
      }
      const draft = await store.load();
      if (draft !== undefined) {
        await store.discard(draft.revision);
        this.knownSetupDraftRevision = undefined;
      }
    } catch (error) {
      const code = error instanceof MiftahError ? error.code : "SETUP_DRAFT_UNAVAILABLE";
      process.emitWarning(
        `Configuration was created, but Miftah could not clear the saved connector choice (${code}). Run 'miftah setup --discard-draft' to remove it later.`,
        { code: "MIFTAH_SETUP_DRAFT_CLEANUP_FAILED" }
      );
    }
  }

  private async setupTarget(
    name: string
  ): Promise<{ readonly application: ConsoleApplicationService; readonly name: string; readonly path: string }> {
    const discovered = await this.discover();
    if (discovered.catalog.discoveryState !== "ready") {
      throw new MiftahError(
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE",
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE: the standard configuration directory could not be inspected safely"
      );
    }
    if (discovered.configurations.length === 0) {
      return { application: this.firstRunApplication, name, path: this.options.defaultConfigPath };
    }
    if (!returningConfigurationName.test(name)) {
      throw new MiftahError(
        "CONSOLE_CONFIGURATION_TARGET_INVALID",
        "CONSOLE_CONFIGURATION_TARGET_INVALID: choose a short lowercase configuration name"
      );
    }
    const normalizedName = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
    if (discovered.configurations.some((configuration) => configuration.metadata.name === normalizedName)) {
      throw new MiftahError(
        "CONFIG_ALREADY_EXISTS",
        "CONFIG_ALREADY_EXISTS: refusing to create a duplicate named configuration"
      );
    }
    const trustedDirectory = trustedDirectoryFor(discovered);
    if (trustedDirectory === undefined) {
      throw new MiftahError(
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE",
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE: the standard configuration directory identity is unavailable"
      );
    }
    const path = join(trustedDirectory.path, `${normalizedName}.json`);
    return {
      application: this.applicationFor(path, undefined, trustedDirectory),
      name: normalizedName,
      path
    };
  }

  private async confirmCreatedFirstRunConfiguration(configPath = this.options.defaultConfigPath): Promise<void> {
    const refreshed = await this.discover();
    const configuredPath = resolvePath(configPath);
    const createdPath = await realpath(configuredPath).catch((error: unknown) => {
      if (fileErrorCode(error) === "ENOENT") return configuredPath;
      throw new MiftahError(
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE",
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE: the created configuration could not be canonicalized safely",
        { cause: error }
      );
    });
    const created = refreshed.configurations.find((configuration) => configuration.path === createdPath);
    if (refreshed.catalog.discoveryState !== "ready" || created === undefined || trustedConfigurationFor(created) === undefined) {
      throw new MiftahError(
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE",
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE: the created configuration could not be registered safely"
      );
    }
    // A later operation must always start with an explicit selection of the
    // newly catalogued bytes, rather than auto-binding a post-create pathname.
    this.active = undefined;
  }

  private selectedFrom(discovered: ConsoleConfigCatalogDiscovery): SelectedConsoleConfiguration | undefined {
    const active = this.active;
    if (active === undefined) return undefined;
    const configuration = discovered.configurations.find((candidate) => candidate.metadata.id === active.id);
    const trustedConfiguration = configuration === undefined ? undefined : trustedConfigurationFor(configuration);
    if (configuration === undefined || trustedConfiguration === undefined || trustedConfiguration.contentDigest !== active.contentDigest) {
      this.active = undefined;
      return undefined;
    }
    return { configuration, trustedConfiguration };
  }

  private async discover(): Promise<ConsoleConfigCatalogDiscovery> {
    if (this.discoveryInFlight !== undefined) return this.discoveryInFlight;
    const discovery = discoverConsoleConfigCatalog({ configDirectory: this.options.configDirectory }).then((discovered) => {
      if (
        this.active !== undefined &&
        !discovered.configurations.some((configuration) => configuration.metadata.id === this.active?.id)
      ) {
        this.active = undefined;
      }
      return discovered;
    });
    this.discoveryInFlight = discovery;
    try {
      return await discovery;
    } finally {
      if (this.discoveryInFlight === discovery) this.discoveryInFlight = undefined;
    }
  }
}
