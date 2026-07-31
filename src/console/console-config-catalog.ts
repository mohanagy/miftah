import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createConfigMigrationSource } from "../cli/migrate-config.js";
import {
  verifyWindowsConfigPathSecurity,
  verifyWindowsConfigPathsSecurity,
  type WindowsPrivatePath
} from "../cli/windows-config-acl.js";
import { loadConfigFromText } from "../config/load-config.js";
import {
  consoleInitializedConfigMetadata,
  type ConsoleConfigCatalog,
  type ConsoleConfigCatalogAttention,
  type ConsoleConfigCatalogAttentionReason,
  type ConsoleDiscoveredConfiguration
} from "./console-config-metadata.js";
import type { ConsoleTrustedConfiguration } from "./console-trusted-configuration.js";

const configurationFileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u;
const maximumConfigurationBytes = 1024 * 1024;
const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const readOnlyFlags = constants.O_RDONLY | noFollowFlag;

export interface ConsoleConfigCatalogDiscoveryOptions {
  /** The only directory inspected by no-config dashboard discovery. */
  readonly configDirectory: string;
  /** Test seam for platform-specific filesystem semantics. */
  readonly platform?: NodeJS.Platform;
  /** Test seam for POSIX ownership validation. */
  readonly ownerUid?: number;
  /** Test seam for Windows DACL verification. */
  readonly windowsAclVerifier?: WindowsConfigAclVerifier;
  /** Test seam for batched Windows DACL verification of one stable boundary. */
  readonly windowsAclPathsVerifier?: WindowsConfigAclPathsVerifier;
  /** Test-only opaque diagnostic observer for one catalog invocation. */
  readonly candidateStageObserver?: ConsoleConfigCatalogCandidateStageObserver;
  /** Test-only comparison of number and BigInt file-handle identities. */
  readonly candidateIdentityObserver?: ConsoleConfigCatalogCandidateIdentityDiagnosticObserver;
}

export type WindowsConfigAclVerifier = (path: string, kind: "file" | "directory") => Promise<boolean>;

export type WindowsConfigAclPathsVerifier = (paths: readonly WindowsPrivatePath[]) => Promise<boolean>;

/** Opaque test-only stages for diagnosing a rejected catalog candidate. */
export type ConsoleConfigCatalogCandidateStage =
  | "acl"
  | "open"
  | "opened-validation"
  | "read"
  | "after-read-validation"
  | "decode"
  | "parse"
  | "migration-source"
  | "close"
  | "dedupe"
  | "metadata"
  | "accepted"
  | "candidate";

/** A stage outcome never carries a path, filesystem identity, config value, or error detail. */
export type ConsoleConfigCatalogCandidateOutcome = "success" | "rejected" | "duplicate" | "error";

export interface ConsoleConfigCatalogCandidateStageEvent {
  /** Stable only within one discovery invocation; never derived from a pathname. */
  readonly candidateIndex: number;
  readonly stage: ConsoleConfigCatalogCandidateStage;
  readonly outcome: ConsoleConfigCatalogCandidateOutcome;
}

/** Test-only observer for opaque candidate diagnostics. */
export type ConsoleConfigCatalogCandidateStageObserver = (event: ConsoleConfigCatalogCandidateStageEvent) => void;

/**
 * Test-only identity comparison. It never carries a path, identity value, or
 * configuration data; it only says whether this candidate matches an earlier
 * candidate under each Node Stats representation.
 */
export interface ConsoleConfigCatalogCandidateIdentityDiagnosticEvent {
  readonly candidateIndex: number;
  readonly numberDuplicate: boolean;
  readonly bigintDuplicate: boolean;
}

/** Test-only observer for opaque file-identity comparisons. */
export type ConsoleConfigCatalogCandidateIdentityDiagnosticObserver = (
  event: ConsoleConfigCatalogCandidateIdentityDiagnosticEvent
) => void;

type TrustedConfigurationFileHandle = Awaited<ReturnType<typeof open>>;

interface WindowsCatalogAclBoundary {
  verified: boolean;
}

function observeCandidateStage(
  observer: ConsoleConfigCatalogCandidateStageObserver | undefined,
  candidateIndex: number,
  stage: ConsoleConfigCatalogCandidateStage,
  outcome: ConsoleConfigCatalogCandidateOutcome
): void {
  observer?.({ candidateIndex, stage, outcome });
}

export interface DiscoveredConsoleConfiguration {
  /** Canonical local path retained only in the in-process registry. */
  readonly path: string;
  readonly metadata: ConsoleDiscoveredConfiguration;
  /** Safe metadata derived from the exact verified file; never sent with a path. */
  readonly initializedMetadata: ReturnType<typeof consoleInitializedConfigMetadata>;
}

export interface ConsoleConfigCatalogDiscovery {
  readonly catalog: ConsoleConfigCatalog;
  readonly configurations: readonly DiscoveredConsoleConfiguration[];
}

export interface ConsoleTrustedCatalogDirectory {
  readonly path: string;
  /** Exact-width POSIX device/inode identity captured by guarded discovery. */
  readonly identity: string;
}

type TrustedConfigurationCandidate =
  | {
      readonly status: "accepted";
      readonly path: string;
      /** Exact-width identity used for security comparisons and catalog dedupe. */
      readonly identity: string;
      /** Test-only Number projection retained to diagnose platform precision loss. */
      readonly numberIdentity?: string;
      readonly trustedConfiguration: ConsoleTrustedConfiguration;
    }
  | {
      readonly status: "attention";
      readonly reason: ConsoleConfigCatalogAttentionReason;
    };

/** Sensitive verified bytes/configuration stay off the serializable catalog entry. */
const trustedConfigurations = new WeakMap<DiscoveredConsoleConfiguration, ConsoleTrustedConfiguration>();
/** Canonical directory paths and identities stay off the serializable discovery result. */
const trustedDirectories = new WeakMap<ConsoleConfigCatalogDiscovery, ConsoleTrustedCatalogDirectory>();

export function trustedConfigurationFor(
  configuration: DiscoveredConsoleConfiguration
): ConsoleTrustedConfiguration | undefined {
  return trustedConfigurations.get(configuration);
}

export function trustedDirectoryFor(
  discovery: ConsoleConfigCatalogDiscovery
): ConsoleTrustedCatalogDirectory | undefined {
  return trustedDirectories.get(discovery);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Uses exact-width IDs because Node Number file IDs can be lossy on Windows. */
export function sameBigIntFileIdentity(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: Pick<BigIntStats, "dev" | "ino">
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function bigintFileIdentity(entry: Pick<BigIntStats, "dev" | "ino">): string {
  return `${entry.dev}:${entry.ino}`;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

function hasExpectedOwner(entry: Pick<Stats | BigIntStats, "uid">, ownerUid: number | undefined): boolean {
  if (ownerUid === undefined) return true;
  return typeof entry.uid === "bigint" ? entry.uid === BigInt(ownerUid) : entry.uid === ownerUid;
}

function hasSafeDirectoryMode(entry: Pick<Stats | BigIntStats, "mode">, platform: NodeJS.Platform): boolean {
  // Node does not expose Windows DACLs through Stats. The established Miftah
  // Windows permission diagnostic is similarly skipped; non-link/canonical
  // validation remains enforced on every platform.
  return platform === "win32" || (Number(entry.mode) & 0o022) === 0;
}

function hasSafeFileMode(entry: Pick<Stats | BigIntStats, "mode">, platform: NodeJS.Platform): boolean {
  return platform === "win32" || (Number(entry.mode) & 0o066) === 0;
}

function isTrustedDirectory(entry: Stats | BigIntStats, ownerUid: number | undefined, platform: NodeJS.Platform): boolean {
  return entry.isDirectory() && !entry.isSymbolicLink() && hasExpectedOwner(entry, ownerUid) && hasSafeDirectoryMode(entry, platform);
}

function isTrustedFile(entry: Stats | BigIntStats, ownerUid: number | undefined, platform: NodeJS.Platform): boolean {
  return entry.isFile() && !entry.isSymbolicLink() && hasExpectedOwner(entry, ownerUid) && hasSafeFileMode(entry, platform);
}

function hasTrustedFilePermissions(
  entry: Pick<Stats | BigIntStats, "uid" | "mode">,
  ownerUid: number | undefined,
  platform: NodeJS.Platform
): boolean {
  return hasExpectedOwner(entry, ownerUid) && hasSafeFileMode(entry, platform);
}

function configurationId(path: string): string {
  return createHash("sha256").update(path).digest("base64url");
}

function defaultOwnerUid(platform: NodeJS.Platform): number | undefined {
  return platform === "win32" || typeof process.getuid !== "function" ? undefined : process.getuid();
}

async function hasTrustedWindowsAcl(
  paths: readonly WindowsPrivatePath[],
  platform: NodeJS.Platform,
  verifier: WindowsConfigAclVerifier,
  pathsVerifier: WindowsConfigAclPathsVerifier,
  useBatchedVerifier: boolean
): Promise<boolean> {
  if (platform !== "win32") return true;
  try {
    if (useBatchedVerifier) return await pathsVerifier(paths);
    for (const path of paths) {
      if (!(await verifier(path.path, path.kind))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function trustedDirectory(
  directory: string,
  ownerUid: number | undefined,
  platform: NodeJS.Platform,
  windowsAclVerifier: WindowsConfigAclVerifier,
  windowsAclPathsVerifier: WindowsConfigAclPathsVerifier,
  useBatchedWindowsAclVerifier: boolean
): Promise<ConsoleTrustedCatalogDirectory | undefined> {
  let observed: BigIntStats;
  try {
    observed = await lstat(directory, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!isTrustedDirectory(observed, ownerUid, platform)) throw new Error("unsafe configuration directory");
  const canonical = await realpath(directory);
  const resolved = await lstat(canonical, { bigint: true });
  if (!isTrustedDirectory(resolved, ownerUid, platform) || !sameBigIntFileIdentity(observed, resolved)) {
    throw new Error("unsafe configuration directory");
  }
  if (!useBatchedWindowsAclVerifier && !(await hasTrustedWindowsAcl(
    [{ path: canonical, kind: "directory" }],
    platform,
    windowsAclVerifier,
    windowsAclPathsVerifier,
    false
  ))) {
    throw new Error("unsafe configuration directory");
  }
  return { path: canonical, identity: bigintFileIdentity(resolved) };
}

async function closeTrustedConfigurationHandle(
  handle: TrustedConfigurationFileHandle,
  candidateIndex: number,
  candidateStageObserver: ConsoleConfigCatalogCandidateStageObserver | undefined
): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    observeCandidateStage(candidateStageObserver, candidateIndex, "close", "error");
    // Candidate discovery deliberately fails closed if any guarded-read cleanup fails.
    throw error;
  }
  observeCandidateStage(candidateStageObserver, candidateIndex, "close", "success");
}

async function readTrustedConfiguration(
  path: string,
  directory: string,
  ownerUid: number | undefined,
  platform: NodeJS.Platform,
  windowsAclVerifier: WindowsConfigAclVerifier,
  windowsAclPathsVerifier: WindowsConfigAclPathsVerifier,
  useBatchedWindowsAclVerifier: boolean,
  windowsAclBoundary: WindowsCatalogAclBoundary,
  candidateIndex: number,
  candidateStageObserver: ConsoleConfigCatalogCandidateStageObserver | undefined,
  candidateIdentityObserver: ConsoleConfigCatalogCandidateIdentityDiagnosticObserver | undefined
): Promise<TrustedConfigurationCandidate> {
  const observed = await lstat(path, { bigint: true });
  if (!observed.isFile() || observed.isSymbolicLink()) {
    return { status: "attention", reason: "unsafe-path" };
  }
  if (!hasTrustedFilePermissions(observed, ownerUid, platform)) {
    return { status: "attention", reason: "file-permissions" };
  }
  const canonical = await realpath(path);
  if (!isWithin(directory, canonical)) return { status: "attention", reason: "unsafe-path" };
  const resolved = await stat(canonical, { bigint: true });
  if (!resolved.isFile() || resolved.isSymbolicLink() || !sameBigIntFileIdentity(observed, resolved)) {
    return { status: "attention", reason: "unsafe-path" };
  }
  if (!hasTrustedFilePermissions(resolved, ownerUid, platform)) {
    return { status: "attention", reason: "file-permissions" };
  }
  const aclPaths: readonly WindowsPrivatePath[] = useBatchedWindowsAclVerifier
    ? [{ path: directory, kind: "directory" }, { path: canonical, kind: "file" }]
    : [{ path: canonical, kind: "file" }];
  if (!(await hasTrustedWindowsAcl(
    aclPaths,
    platform,
    windowsAclVerifier,
    windowsAclPathsVerifier,
    useBatchedWindowsAclVerifier
  ))) {
    observeCandidateStage(candidateStageObserver, candidateIndex, "acl", "rejected");
    return { status: "attention", reason: "file-permissions" };
  }
  if (useBatchedWindowsAclVerifier) windowsAclBoundary.verified = true;
  observeCandidateStage(candidateStageObserver, candidateIndex, "acl", "success");

  let handle: TrustedConfigurationFileHandle;
  try {
    handle = await open(canonical, readOnlyFlags);
  } catch (error) {
    observeCandidateStage(candidateStageObserver, candidateIndex, "open", "error");
    throw error;
  }
  observeCandidateStage(candidateStageObserver, candidateIndex, "open", "success");
  try {
    let opened: Stats;
    let openedIdentity: BigIntStats;
    try {
      [opened, openedIdentity] = await Promise.all([handle.stat(), handle.stat({ bigint: true })]);
    } catch (error) {
      observeCandidateStage(candidateStageObserver, candidateIndex, "opened-validation", "error");
      throw error;
    }
    if (
      !isTrustedFile(openedIdentity, ownerUid, platform) ||
      !sameBigIntFileIdentity(observed, openedIdentity) ||
      opened.size > maximumConfigurationBytes
    ) {
      observeCandidateStage(candidateStageObserver, candidateIndex, "opened-validation", "rejected");
      return {
        status: "attention",
        reason: hasTrustedFilePermissions(openedIdentity, ownerUid, platform)
          ? "unsafe-path"
          : "file-permissions"
      };
    }
    observeCandidateStage(candidateStageObserver, candidateIndex, "opened-validation", "success");
    const identity = bigintFileIdentity(openedIdentity);
    const numberIdentity = candidateIdentityObserver === undefined ? undefined : `${opened.dev}:${opened.ino}`;
    let content: Buffer;
    try {
      content = await handle.readFile();
    } catch (error) {
      observeCandidateStage(candidateStageObserver, candidateIndex, "read", "error");
      throw error;
    }
    observeCandidateStage(candidateStageObserver, candidateIndex, "read", "success");
    let afterRead: Stats;
    let afterReadIdentity: BigIntStats;
    try {
      [afterRead, afterReadIdentity] = await Promise.all([handle.stat(), handle.stat({ bigint: true })]);
    } catch (error) {
      observeCandidateStage(candidateStageObserver, candidateIndex, "after-read-validation", "error");
      throw error;
    }
    if (
      !isTrustedFile(afterReadIdentity, ownerUid, platform) ||
      !sameBigIntFileIdentity(observed, afterReadIdentity) ||
      afterReadIdentity.size !== openedIdentity.size ||
      content.byteLength > maximumConfigurationBytes
    ) {
      observeCandidateStage(candidateStageObserver, candidateIndex, "after-read-validation", "rejected");
      return {
        status: "attention",
        reason: hasTrustedFilePermissions(afterReadIdentity, ownerUid, platform)
          ? "unsafe-path"
          : "file-permissions"
      };
    }
    observeCandidateStage(candidateStageObserver, candidateIndex, "after-read-validation", "success");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      observeCandidateStage(candidateStageObserver, candidateIndex, "decode", "error");
      return { status: "attention", reason: "invalid-configuration" };
    }
    observeCandidateStage(candidateStageObserver, candidateIndex, "decode", "success");
    let config: ReturnType<typeof loadConfigFromText>;
    try {
      config = loadConfigFromText(text, canonical);
    } catch {
      observeCandidateStage(candidateStageObserver, candidateIndex, "parse", "error");
      return { status: "attention", reason: "invalid-configuration" };
    }
    observeCandidateStage(candidateStageObserver, candidateIndex, "parse", "success");
    let migrationSource: ReturnType<typeof createConfigMigrationSource>;
    try {
      migrationSource = createConfigMigrationSource(content, afterRead);
    } catch {
      observeCandidateStage(candidateStageObserver, candidateIndex, "migration-source", "error");
      return { status: "attention", reason: "invalid-configuration" };
    }
    observeCandidateStage(candidateStageObserver, candidateIndex, "migration-source", "success");
    return {
      status: "accepted",
      path: canonical,
      identity,
      ...(numberIdentity === undefined ? {} : { numberIdentity }),
      trustedConfiguration: {
        config,
        contentDigest: createHash("sha256").update(content).digest("base64url"),
        migrationSource
      }
    };
  } finally {
    await closeTrustedConfigurationHandle(handle, candidateIndex, candidateStageObserver);
  }
}

function catalogAttention(
  attentionCounts: ReadonlyMap<ConsoleConfigCatalogAttentionReason, number>
): readonly ConsoleConfigCatalogAttention[] {
  const exhaustiveOrder = {
    "file-permissions": true,
    "invalid-configuration": true,
    "unsafe-path": true,
    "duplicate": true,
    "unreadable": true
  } satisfies Record<ConsoleConfigCatalogAttentionReason, true>;
  const order = Object.keys(exhaustiveOrder) as ConsoleConfigCatalogAttentionReason[];
  return order.flatMap((reason) => {
    const count = attentionCounts.get(reason) ?? 0;
    return count === 0 ? [] : [{ reason, count }];
  });
}

function readyCatalog(
  discoveredCount: number,
  configurations: readonly DiscoveredConsoleConfiguration[],
  attentionCounts: ReadonlyMap<ConsoleConfigCatalogAttentionReason, number>
): ConsoleConfigCatalog {
  const attentionReasons = catalogAttention(attentionCounts);
  return {
    source: "standard-config-directory",
    discoveryState: "ready",
    discoveredCount,
    readyCount: configurations.length,
    attentionCount: attentionReasons.reduce((total, item) => total + item.count, 0),
    attentionReasons,
    configurations: configurations.map((configuration) => configuration.metadata)
  };
}

/**
 * Discovers only direct, trusted JSON files in Miftah's standard configuration
 * directory. Invalid or unsafe candidates are deliberately not surfaced.
 */
export async function discoverConsoleConfigCatalog(
  options: ConsoleConfigCatalogDiscoveryOptions
): Promise<ConsoleConfigCatalogDiscovery> {
  const platform = options.platform ?? process.platform;
  const ownerUid = options.ownerUid ?? defaultOwnerUid(platform);
  const windowsAclVerifier = options.windowsAclVerifier ?? verifyWindowsConfigPathSecurity;
  const windowsAclPathsVerifier = options.windowsAclPathsVerifier ?? verifyWindowsConfigPathsSecurity;
  const useBatchedWindowsAclVerifier = platform === "win32" && (
    options.windowsAclPathsVerifier !== undefined || options.windowsAclVerifier === undefined
  );
  const candidateStageObserver = options.candidateStageObserver;
  const candidateIdentityObserver = options.candidateIdentityObserver;
  let trustedConfigDirectory: ConsoleTrustedCatalogDirectory | undefined;
  try {
    trustedConfigDirectory = await trustedDirectory(
      resolve(options.configDirectory),
      ownerUid,
      platform,
      windowsAclVerifier,
      windowsAclPathsVerifier,
      useBatchedWindowsAclVerifier
    );
  } catch {
    return {
      catalog: { source: "standard-config-directory", discoveryState: "unavailable", configurations: [] },
      configurations: []
    };
  }
  if (trustedConfigDirectory === undefined) {
    return {
      catalog: {
        source: "standard-config-directory",
        discoveryState: "ready",
        discoveredCount: 0,
        readyCount: 0,
        attentionCount: 0,
        attentionReasons: [],
        configurations: []
      },
      configurations: []
    };
  }
  const directory = trustedConfigDirectory.path;

  // The default Windows path verifies the canonical directory and each
  // candidate together below. Names are not surfaced until that bounded
  // trusted boundary succeeds; an empty or rejected catalog still verifies
  // the directory alone before it can report readiness.
  let names: readonly string[];
  try {
    names = (await readdir(directory)).filter((name) => configurationFileName.test(name)).sort((left, right) => left.localeCompare(right));
  } catch {
    return {
      catalog: { source: "standard-config-directory", discoveryState: "unavailable", configurations: [] },
      configurations: []
    };
  }

  const identities = new Set<string>();
  const numberIdentities = candidateIdentityObserver === undefined ? undefined : new Set<string>();
  const configurations: DiscoveredConsoleConfiguration[] = [];
  const attentionCounts = new Map<ConsoleConfigCatalogAttentionReason, number>();
  const recordAttention = (reason: ConsoleConfigCatalogAttentionReason): void => {
    attentionCounts.set(reason, (attentionCounts.get(reason) ?? 0) + 1);
  };
  const windowsAclBoundary: WindowsCatalogAclBoundary = { verified: !useBatchedWindowsAclVerifier };
  for (const [candidateIndex, name] of names.entries()) {
    let failureReason: ConsoleConfigCatalogAttentionReason = "unreadable";
    try {
      const discovered = await readTrustedConfiguration(
        join(directory, name),
        directory,
        ownerUid,
        platform,
        windowsAclVerifier,
        windowsAclPathsVerifier,
        useBatchedWindowsAclVerifier,
        windowsAclBoundary,
        candidateIndex,
        candidateStageObserver,
        candidateIdentityObserver
      );
      if (discovered.status === "attention") {
        recordAttention(discovered.reason);
        continue;
      }
      failureReason = "invalid-configuration";
      const bigintDuplicate = identities.has(discovered.identity);
      const numberDuplicate = discovered.numberIdentity !== undefined && numberIdentities?.has(discovered.numberIdentity) === true;
      candidateIdentityObserver?.({ candidateIndex, numberDuplicate, bigintDuplicate });
      if (bigintDuplicate) {
        observeCandidateStage(candidateStageObserver, candidateIndex, "dedupe", "duplicate");
        recordAttention("duplicate");
        continue;
      }
      identities.add(discovered.identity);
      if (discovered.numberIdentity !== undefined) numberIdentities?.add(discovered.numberIdentity);
      observeCandidateStage(candidateStageObserver, candidateIndex, "dedupe", "success");
      let summary: ReturnType<typeof consoleInitializedConfigMetadata>;
      try {
        summary = consoleInitializedConfigMetadata(discovered.trustedConfiguration.config);
      } catch (error) {
        observeCandidateStage(candidateStageObserver, candidateIndex, "metadata", "error");
        throw error;
      }
      observeCandidateStage(candidateStageObserver, candidateIndex, "metadata", "success");
      const configuration: DiscoveredConsoleConfiguration = {
        path: discovered.path,
        initializedMetadata: summary,
        metadata: {
          id: configurationId(discovered.path),
          name: summary.name,
          version: summary.version,
          profileCount: summary.profiles.length,
          profileNames: summary.profiles.map(({ name }) => name),
          defaultProfile: summary.defaultProfile,
          profileSwitchingFromMcp: summary.profileSwitchingFromMcp === true,
          authentication: summary.authentication ?? {
            mode: "miftah-native-oauth",
            credentialOwner: "miftah",
            browserHandoff: "miftah",
            tokenStore: "miftah-vault"
          },
          source: "standard-config-directory"
        }
      };
      trustedConfigurations.set(configuration, discovered.trustedConfiguration);
      configurations.push(configuration);
      observeCandidateStage(candidateStageObserver, candidateIndex, "accepted", "success");
    } catch {
      observeCandidateStage(candidateStageObserver, candidateIndex, "candidate", "error");
      recordAttention(failureReason);
      // A malformed, raced, or untrusted candidate is never a Console entry.
    }
  }
  if (useBatchedWindowsAclVerifier && !windowsAclBoundary.verified && !(await hasTrustedWindowsAcl(
    [{ path: directory, kind: "directory" }],
    platform,
    windowsAclVerifier,
    windowsAclPathsVerifier,
    true
  ))) {
    return {
      catalog: { source: "standard-config-directory", discoveryState: "unavailable", configurations: [] },
      configurations: []
    };
  }
  configurations.sort((left, right) =>
    left.metadata.name.localeCompare(right.metadata.name) || left.metadata.id.localeCompare(right.metadata.id)
  );
  const discovery: ConsoleConfigCatalogDiscovery = {
    catalog: readyCatalog(names.length, configurations, attentionCounts),
    configurations
  };
  trustedDirectories.set(discovery, trustedConfigDirectory);
  return discovery;
}
