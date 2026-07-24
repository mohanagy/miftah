import type { ClientLauncher, ClientSelection, ClientSnippet } from "../cli/client-snippets.js";
import { realpath } from "node:fs/promises";
import { resolvePath } from "../config/path-resolve.js";
import { MiftahError } from "../utils/errors.js";
import {
  ConsoleApplicationService,
  type ConsoleAuditRecord,
  type ConsoleConnectionAddReport,
  type ConsoleConnectionAddRequest,
  type ConsoleControlApplication,
  type ConsoleHealth,
  type ConsoleNativeOAuthOnboardingRequest
} from "./console-application-service.js";
import {
  discoverConsoleConfigCatalog,
  trustedConfigurationFor,
  type ConsoleConfigCatalogDiscovery,
  type DiscoveredConsoleConfiguration
} from "./console-config-catalog.js";
import type { ConsoleConfigCatalog, ConsoleConfigMetadata } from "./console-config-metadata.js";
import type { ConsoleTrustedConfiguration } from "./console-trusted-configuration.js";

export interface ConsoleDashboardApplicationServiceOptions {
  /** Destination used only for a genuine first native OAuth configuration. */
  readonly defaultConfigPath: string;
  /** Bounded source of known configurations; client settings are never inspected. */
  readonly configDirectory: string;
  readonly launcher?: ClientLauncher;
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
  private active: ActiveConsoleConfiguration | undefined;
  private discoveryInFlight: Promise<ConsoleConfigCatalogDiscovery> | undefined;

  constructor(private readonly options: ConsoleDashboardApplicationServiceOptions) {
    this.firstRunApplication = this.applicationFor(options.defaultConfigPath);
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

  async onboardNativeOAuth(request: ConsoleNativeOAuthOnboardingRequest): Promise<ConsoleConnectionAddReport> {
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
    const result = await this.firstRunApplication.onboardNativeOAuth(request);
    const refreshed = await this.discover();
    const configuredPath = resolvePath(this.options.defaultConfigPath);
    const createdPath = await realpath(configuredPath).catch(() => configuredPath);
    const created = refreshed.configurations.find((configuration) => configuration.path === createdPath);
    if (refreshed.catalog.discoveryState !== "ready" || created === undefined) {
      throw new MiftahError(
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE",
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE: the created configuration could not be registered safely"
      );
    }
    if (trustedConfigurationFor(created) === undefined) {
      throw new MiftahError(
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE",
        "CONSOLE_CONFIG_DISCOVERY_UNAVAILABLE: the created configuration could not be registered safely"
      );
    }
    // A later operation must always start with an explicit selection of the
    // newly catalogued bytes, rather than auto-binding a post-create pathname.
    this.active = undefined;
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

  async auditRecords(limit: number): Promise<readonly ConsoleAuditRecord[]> {
    return (await this.selectedApplication()).application.auditRecords(limit);
  }

  private applicationFor(
    configPath: string,
    trustedConfiguration?: ConsoleTrustedConfiguration
  ): ConsoleApplicationService {
    return new ConsoleApplicationService(configPath, {
      ...(this.options.launcher === undefined ? {} : { launcher: this.options.launcher }),
      ...(trustedConfiguration === undefined ? {} : { trustedConfiguration })
    });
  }

  private async selectedApplication(): Promise<SelectedConsoleApplication> {
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
