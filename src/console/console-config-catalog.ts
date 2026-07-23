import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createConfigMigrationSource } from "../cli/migrate-config.js";
import { verifyWindowsConfigPathSecurity } from "../cli/windows-config-acl.js";
import { loadConfigFromText } from "../config/load-config.js";
import {
  consoleInitializedConfigMetadata,
  type ConsoleConfigCatalog,
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
}

export type WindowsConfigAclVerifier = (path: string, kind: "file" | "directory") => Promise<boolean>;

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

/** Sensitive verified bytes/configuration stay off the serializable catalog entry. */
const trustedConfigurations = new WeakMap<DiscoveredConsoleConfiguration, ConsoleTrustedConfiguration>();

export function trustedConfigurationFor(
  configuration: DiscoveredConsoleConfiguration
): ConsoleTrustedConfiguration | undefined {
  return trustedConfigurations.get(configuration);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function sameEntry(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

function hasExpectedOwner(entry: Pick<Stats, "uid">, ownerUid: number | undefined): boolean {
  return ownerUid === undefined || entry.uid === ownerUid;
}

function hasSafeDirectoryMode(entry: Pick<Stats, "mode">, platform: NodeJS.Platform): boolean {
  // Node does not expose Windows DACLs through Stats. The established Miftah
  // Windows permission diagnostic is similarly skipped; non-link/canonical
  // validation remains enforced on every platform.
  return platform === "win32" || (Number(entry.mode) & 0o022) === 0;
}

function hasSafeFileMode(entry: Pick<Stats, "mode">, platform: NodeJS.Platform): boolean {
  return platform === "win32" || (Number(entry.mode) & 0o066) === 0;
}

function isTrustedDirectory(entry: Stats, ownerUid: number | undefined, platform: NodeJS.Platform): boolean {
  return entry.isDirectory() && !entry.isSymbolicLink() && hasExpectedOwner(entry, ownerUid) && hasSafeDirectoryMode(entry, platform);
}

function isTrustedFile(entry: Stats, ownerUid: number | undefined, platform: NodeJS.Platform): boolean {
  return entry.isFile() && !entry.isSymbolicLink() && hasExpectedOwner(entry, ownerUid) && hasSafeFileMode(entry, platform);
}

function configurationId(path: string): string {
  return createHash("sha256").update(path).digest("base64url");
}

function defaultOwnerUid(platform: NodeJS.Platform): number | undefined {
  return platform === "win32" || typeof process.getuid !== "function" ? undefined : process.getuid();
}

async function hasTrustedWindowsAcl(
  path: string,
  kind: "file" | "directory",
  platform: NodeJS.Platform,
  verifier: WindowsConfigAclVerifier
): Promise<boolean> {
  if (platform !== "win32") return true;
  try {
    return await verifier(path, kind);
  } catch {
    return false;
  }
}

async function trustedDirectory(
  directory: string,
  ownerUid: number | undefined,
  platform: NodeJS.Platform,
  windowsAclVerifier: WindowsConfigAclVerifier
): Promise<string | undefined> {
  let observed: Stats;
  try {
    observed = await lstat(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (!isTrustedDirectory(observed, ownerUid, platform)) throw new Error("unsafe configuration directory");
  const canonical = await realpath(directory);
  const resolved = await lstat(canonical);
  if (!isTrustedDirectory(resolved, ownerUid, platform) || !sameEntry(observed, resolved)) {
    throw new Error("unsafe configuration directory");
  }
  if (!(await hasTrustedWindowsAcl(canonical, "directory", platform, windowsAclVerifier))) {
    throw new Error("unsafe configuration directory");
  }
  return canonical;
}

async function readTrustedConfiguration(
  path: string,
  directory: string,
  ownerUid: number | undefined,
  platform: NodeJS.Platform,
  windowsAclVerifier: WindowsConfigAclVerifier
): Promise<{
  readonly path: string;
  readonly identity: string;
  readonly trustedConfiguration: ConsoleTrustedConfiguration;
} | undefined> {
  const observed = await lstat(path);
  if (!isTrustedFile(observed, ownerUid, platform)) return undefined;
  const canonical = await realpath(path);
  if (!isWithin(directory, canonical)) return undefined;
  const resolved = await stat(canonical);
  if (!isTrustedFile(resolved, ownerUid, platform) || !sameEntry(observed, resolved)) return undefined;
  if (!(await hasTrustedWindowsAcl(canonical, "file", platform, windowsAclVerifier))) return undefined;

  const handle = await open(canonical, readOnlyFlags);
  try {
    const opened = await handle.stat();
    if (
      !isTrustedFile(opened, ownerUid, platform) ||
      !sameEntry(observed, opened) ||
      opened.size > maximumConfigurationBytes
    ) {
      return undefined;
    }
    const content = await handle.readFile();
    const afterRead = await handle.stat();
    if (
      !isTrustedFile(afterRead, ownerUid, platform) ||
      !sameEntry(observed, afterRead) ||
      afterRead.size !== opened.size ||
      content.byteLength > maximumConfigurationBytes
    ) {
      return undefined;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    return {
      path: canonical,
      identity: `${opened.dev}:${opened.ino}`,
      trustedConfiguration: {
        config: loadConfigFromText(text, canonical),
        contentDigest: createHash("sha256").update(content).digest("base64url"),
        migrationSource: createConfigMigrationSource(content, afterRead)
      }
    };
  } finally {
    await handle.close();
  }
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
  let directory: string | undefined;
  try {
    directory = await trustedDirectory(resolve(options.configDirectory), ownerUid, platform, windowsAclVerifier);
  } catch {
    return {
      catalog: { source: "standard-config-directory", discoveryState: "unavailable", configurations: [] },
      configurations: []
    };
  }
  if (directory === undefined) {
    return {
      catalog: { source: "standard-config-directory", discoveryState: "ready", configurations: [] },
      configurations: []
    };
  }

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
  const configurations: DiscoveredConsoleConfiguration[] = [];
  for (const name of names) {
    try {
      const discovered = await readTrustedConfiguration(
        join(directory, name),
        directory,
        ownerUid,
        platform,
        windowsAclVerifier
      );
      if (discovered === undefined) continue;
      if (identities.has(discovered.identity)) continue;
      identities.add(discovered.identity);
      const summary = consoleInitializedConfigMetadata(discovered.trustedConfiguration.config);
      const configuration: DiscoveredConsoleConfiguration = {
        path: discovered.path,
        initializedMetadata: summary,
        metadata: {
          id: configurationId(discovered.path),
          name: summary.name,
          version: summary.version,
          profileCount: summary.profiles.length,
          defaultProfile: summary.defaultProfile,
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
    } catch {
      // A malformed, raced, or untrusted candidate is never a Console entry.
    }
  }
  configurations.sort((left, right) =>
    left.metadata.name.localeCompare(right.metadata.name) || left.metadata.id.localeCompare(right.metadata.id)
  );
  return {
    catalog: {
      source: "standard-config-directory",
      discoveryState: "ready",
      configurations: configurations.map((configuration) => configuration.metadata)
    },
    configurations
  };
}
