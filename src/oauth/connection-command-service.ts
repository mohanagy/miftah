import { AuditLogger } from "../audit/audit-logger.js";
import { AuditTrail } from "../audit/audit-trail.js";
import { loadConfig } from "../config/load-config.js";
import { resolvePath } from "../config/path-resolve.js";
import { createRuntime } from "../runtime/create-runtime.js";
import { SecretRedactor } from "../secrets/redact.js";
import { MiftahError } from "../utils/errors.js";
import { realpath } from "node:fs/promises";
import { parseOAuthConnectionRef, type OAuthIdentityState } from "./connection-types.js";
import type {
  RedactedOAuthConnection,
  RedactedOAuthConnectionStatus
} from "./remote-oauth-runtime.js";
import { createRemoteOAuthRuntime, type RemoteOAuthRuntime } from "./remote-oauth-runtime.js";

export interface OAuthConnectionSelector {
  readonly connectionRef?: string;
  readonly profile?: string;
  readonly upstream?: string;
}

export interface OAuthCommandRuntimeOptions {
  readonly interactiveAuthorization: boolean;
  readonly upstreamAccess?: boolean;
  readonly forceAuthorization?: { readonly profile: string; readonly upstream: string };
}

export interface OAuthCommandRuntime {
  connections(): readonly RedactedOAuthConnection[];
  status(profile: string, upstream: string): Promise<RedactedOAuthConnectionStatus>;
  disconnect(profile: string, upstream: string): Promise<RedactedOAuthConnectionStatus>;
  test(profile: string, upstream: string): Promise<{ readonly toolCount: number; readonly identityStatus: string }>;
  close(): Promise<void>;
}

/** Runtime factory port used by both the executable CLI and a future in-process Console. */
export interface OAuthCommandRuntimeFactory {
  connections(configPath: string): Promise<readonly RedactedOAuthConnection[]>;
  open(configPath: string, options: OAuthCommandRuntimeOptions): Promise<OAuthCommandRuntime>;
}

export interface OAuthConnectionTestReport {
  readonly ok: true;
  readonly toolCount: number;
  readonly identityStatus: string;
  readonly connection: RedactedOAuthConnectionStatus;
}

function targetRequired(): never {
  throw new MiftahError(
    "OAUTH_CONNECTION_TARGET_REQUIRED",
    "OAUTH_CONNECTION_TARGET_REQUIRED: select one OAuth connection by reference or exact profile/upstream"
  );
}

function connectionNotFound(): never {
  throw new MiftahError(
    "OAUTH_CONNECTION_NOT_FOUND",
    "OAUTH_CONNECTION_NOT_FOUND: OAuth connection does not exist"
  );
}

function selectConnection(
  connections: readonly RedactedOAuthConnection[],
  selector: OAuthConnectionSelector
): RedactedOAuthConnection {
  if (selector.connectionRef !== undefined) {
    if (selector.profile !== undefined || selector.upstream !== undefined) targetRequired();
    const reference = parseOAuthConnectionRef(selector.connectionRef);
    return connections.find((connection) => connection.connectionRef === reference) ?? connectionNotFound();
  }
  if (selector.upstream !== undefined && selector.profile === undefined) targetRequired();
  const candidates = connections.filter(
    (connection) =>
      (selector.profile === undefined || connection.profile === selector.profile) &&
      (selector.upstream === undefined || connection.upstream === selector.upstream)
  );
  if (candidates.length === 0) connectionNotFound();
  if (candidates.length !== 1) targetRequired();
  return candidates[0] as RedactedOAuthConnection;
}

/** Stable redacted lifecycle operations shared by CLI and future Console handlers. */
export class OAuthConnectionCommandService {
  constructor(
    private readonly configPath: string,
    private readonly factory: OAuthCommandRuntimeFactory = new NativeOAuthCommandRuntimeFactory()
  ) {}

  async list(): Promise<readonly RedactedOAuthConnectionStatus[]> {
    const configured = await this.factory.connections(this.configPath);
    if (configured.length === 0) return [];
    const runtime = await this.factory.open(this.configPath, { interactiveAuthorization: false });
    try {
      return await Promise.all(configured.map((connection) => runtime.status(connection.profile, connection.upstream)));
    } finally {
      await runtime.close();
    }
  }

  async status(selector: OAuthConnectionSelector): Promise<RedactedOAuthConnectionStatus> {
    const target = await this.resolve(selector);
    const runtime = await this.factory.open(this.configPath, { interactiveAuthorization: false });
    try {
      return await runtime.status(target.profile, target.upstream);
    } finally {
      await runtime.close();
    }
  }

  test(selector: OAuthConnectionSelector): Promise<OAuthConnectionTestReport> {
    return this.authorizeOrTest(selector, { interactiveAuthorization: false, upstreamAccess: true });
  }

  connect(
    selector: OAuthConnectionSelector,
    options: { readonly nonInteractive?: boolean } = {}
  ): Promise<OAuthConnectionTestReport> {
    return this.authorizeOrTest(selector, {
      interactiveAuthorization: options.nonInteractive !== true,
      upstreamAccess: true
    });
  }

  async reauth(
    selector: OAuthConnectionSelector,
    options: { readonly nonInteractive?: boolean } = {}
  ): Promise<OAuthConnectionTestReport> {
    const target = await this.resolve(selector);
    return this.runTest(target, {
      interactiveAuthorization: options.nonInteractive !== true,
      upstreamAccess: true,
      forceAuthorization: { profile: target.profile, upstream: target.upstream }
    });
  }

  async disconnect(selector: OAuthConnectionSelector): Promise<RedactedOAuthConnectionStatus> {
    const target = await this.resolve(selector);
    const runtime = await this.factory.open(this.configPath, { interactiveAuthorization: false });
    try {
      return await runtime.disconnect(target.profile, target.upstream);
    } finally {
      await runtime.close();
    }
  }

  private async authorizeOrTest(
    selector: OAuthConnectionSelector,
    options: OAuthCommandRuntimeOptions
  ): Promise<OAuthConnectionTestReport> {
    return this.runTest(await this.resolve(selector), options);
  }

  private async runTest(
    target: RedactedOAuthConnection,
    options: OAuthCommandRuntimeOptions
  ): Promise<OAuthConnectionTestReport> {
    const runtime = await this.factory.open(this.configPath, options);
    try {
      const result = await runtime.test(target.profile, target.upstream);
      return {
        ok: true,
        ...result,
        connection: await runtime.status(target.profile, target.upstream)
      };
    } finally {
      await runtime.close();
    }
  }

  private async resolve(selector: OAuthConnectionSelector): Promise<RedactedOAuthConnection> {
    return selectConnection(await this.factory.connections(this.configPath), selector);
  }
}

function identityState(status: string): OAuthIdentityState {
  if (status === "verified") return "verified";
  if (status === "mismatch") return "changed";
  if (status === "unconfigured" || status === "unsupported") return "unsupported";
  return "unavailable";
}

/** Production adapter; it is intentionally in-process and never shells out to Miftah commands. */
export class NativeOAuthCommandRuntimeFactory implements OAuthCommandRuntimeFactory {
  async connections(configPath: string): Promise<readonly RedactedOAuthConnection[]> {
    const config = await loadConfig(configPath);
    if (config.version !== "3") return [];
    return Object.entries(config.oauth?.connections ?? {})
      .map(([connectionRef, connection]) => ({
        connectionRef,
        profile: connection.profile,
        upstream: connection.upstream,
        resource: connection.resource,
        issuer: connection.issuer,
        clientRegistration: connection.clientRegistration,
        scopes: [...connection.scopes]
      }))
      .sort((left, right) => left.connectionRef.localeCompare(right.connectionRef));
  }

  async open(configPath: string, options: OAuthCommandRuntimeOptions): Promise<OAuthCommandRuntime> {
    if (options.upstreamAccess !== true) {
      const configuredPath = resolvePath(configPath);
      const runtimeConfigPath = await realpath(configuredPath).catch(() => configuredPath);
      const config = await loadConfig(runtimeConfigPath);
      const redactor = new SecretRedactor();
      const oauth = await createRemoteOAuthRuntime(runtimeConfigPath, config, redactor, {
        interactiveAuthorization: false
      });
      if (oauth === undefined) connectionNotFound();
      this.attachAudit(oauth, config, redactor);
      return {
        connections: () => oauth.connections(),
        status: (profile, upstream) => oauth.status(profile, upstream),
        disconnect: (profile, upstream) => oauth.disconnect(profile, upstream),
        test: async () => {
          throw new MiftahError(
            "OAUTH_INTERACTIVE_REQUIRED",
            "OAUTH_INTERACTIVE_REQUIRED: upstream access was not enabled for this operation"
          );
        },
        close: async () => undefined
      };
    }
    const runtime = await createRuntime(configPath, undefined, {
      oauth: {
        interactiveAuthorization: options.interactiveAuthorization,
        ...(options.forceAuthorization === undefined ? {} : { forceAuthorization: options.forceAuthorization })
      }
    });
    const oauth = runtime.oauth;
    if (oauth === undefined) {
      await runtime.manager.close();
      connectionNotFound();
    }
    this.attachAudit(oauth, runtime.config, runtime.redactor);
    return {
      connections: () => oauth.connections(),
      status: (profile, upstream) => oauth.status(profile, upstream),
      disconnect: (profile, upstream) => oauth.disconnect(profile, upstream),
      test: async (profile, upstream) => {
        const session = await runtime.manager.get(profile, upstream);
        const tools = (await session.listTools()).tools;
        const identity = await runtime.identities.verify(profile, upstream, session, { force: true });
        await oauth.recordIdentityState(profile, upstream, identityState(identity.status));
        if (identity.status === "mismatch" || identity.status === "failed") {
          const code = identity.errorCode ?? "IDENTITY_VERIFICATION_FAILED";
          throw new MiftahError(code, `${code}: identity verification did not complete for profile '${profile}'`);
        }
        return { toolCount: tools.length, identityStatus: identity.status };
      },
      close: () => runtime.manager.close()
    };
  }

  private attachAudit(
    oauth: RemoteOAuthRuntime,
    config: Awaited<ReturnType<typeof loadConfig>>,
    redactor: SecretRedactor
  ): void {
    if (config.audit?.enabled === false || !config.audit?.path) return;
    oauth.attachAuditTrail(
      new AuditTrail(
        config.name,
        new AuditLogger(config.audit.path, {
          includeArguments: config.audit.includeArguments,
          redactor,
          failureMode: config.audit.failureMode,
          rotation: config.audit.rotation,
          integrity: config.audit.integrity
        })
      )
    );
  }
}
