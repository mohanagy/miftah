import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { ProfileIsolationConfig, TransportType } from "../config/types.js";
import { SecretRedactor } from "../secrets/redact.js";
import { MiftahError } from "../utils/errors.js";

const maximumMappedFileBytes = 1_048_576;
const markerName = ".miftah-profile-isolation.json";
const runtimeVersion = "v1";

export interface ProfileRuntimeIsolationOptions {
  readonly configPath: string;
  readonly redactor: SecretRedactor;
  /** Internal test seam for platform-specific path canonicalization. */
  readonly platform?: NodeJS.Platform;
}

export interface PreparedProfileRuntimeIsolation {
  readonly environment: Record<string, string>;
}

interface MaterializedFile {
  readonly destination: string;
  readonly environment?: string;
}

/**
 * Materializes configuration-owned credential files into deterministic, owner-restricted profile/upstream runtime trees.
 * It intentionally never removes a runtime tree: those paths may contain an upstream-owned OAuth session.
 */
export class ProfileRuntimeIsolation {
  private readonly platform: NodeJS.Platform;
  private readonly configDirectory: Promise<string>;

  constructor(private readonly options: ProfileRuntimeIsolationOptions) {
    this.platform = options.platform ?? process.platform;
    this.configDirectory = this.resolveConfigDirectory();
  }

  async prepare(
    profile: string,
    upstreamName: string,
    isolation: ProfileIsolationConfig | undefined,
    transport: TransportType
  ): Promise<PreparedProfileRuntimeIsolation> {
    if (isolation === undefined) return { environment: {} };
    if (transport !== "stdio") throw isolationFailure();
    if ((isolation.containerVolumes?.length ?? 0) > 0) throw isolationFailure();

    try {
      const configDirectory = await this.configDirectory;
      const root = await this.ensureRuntimeRoot(configDirectory, profile, upstreamName);
      const directories = await this.ensureRuntimeDirectories(root);
      const files = await this.materializeFiles(configDirectory, root, isolation.files ?? []);
      const environment: Record<string, string> = {
        HOME: directories.home,
        USERPROFILE: directories.home,
        APPDATA: directories.appData,
        LOCALAPPDATA: directories.localAppData,
        XDG_CONFIG_HOME: directories.xdgConfig,
        XDG_CACHE_HOME: directories.xdgCache,
        XDG_DATA_HOME: directories.xdgData,
        XDG_STATE_HOME: directories.xdgState,
        XDG_RUNTIME_DIR: directories.xdgRuntime
      };
      for (const file of files) {
        if (file.environment !== undefined) environment[file.environment] = file.destination;
      }
      return { environment };
    } catch {
      throw isolationFailure();
    }
  }

  private async resolveConfigDirectory(): Promise<string> {
    try {
      return dirname(await realpath(this.options.configPath));
    } catch {
      throw isolationFailure();
    }
  }

  private async ensureRuntimeRoot(configDirectory: string, profile: string, upstreamName: string): Promise<string> {
    const configIdentity = hash(configDirectory);
    const targetIdentity = hash(`${profile}\u0000${upstreamName}`);
    let current = configDirectory;
    let targetCreated = false;
    const segments = [".miftah", "runtime", runtimeVersion, configIdentity, targetIdentity];
    for (const [index, segment] of segments.entries()) {
      const directory = await ensureOwnedDirectoryState(current, segment);
      current = directory.path;
      if (index === segments.length - 1) targetCreated = directory.created;
    }
    await ensureMarker(current, { version: runtimeVersion, configIdentity, targetIdentity }, targetCreated);
    return current;
  }

  private async ensureRuntimeDirectories(root: string): Promise<{
    home: string;
    appData: string;
    localAppData: string;
    xdgConfig: string;
    xdgCache: string;
    xdgData: string;
    xdgState: string;
    xdgRuntime: string;
  }> {
    const home = await ensureOwnedDirectory(root, "home");
    const appData = await ensureOwnedDirectory(root, "appdata");
    const localAppData = await ensureOwnedDirectory(root, "localappdata");
    const xdg = await ensureOwnedDirectory(root, "xdg");
    return {
      home,
      appData,
      localAppData,
      xdgConfig: await ensureOwnedDirectory(xdg, "config"),
      xdgCache: await ensureOwnedDirectory(xdg, "cache"),
      xdgData: await ensureOwnedDirectory(xdg, "data"),
      xdgState: await ensureOwnedDirectory(xdg, "state"),
      xdgRuntime: await ensureOwnedDirectory(xdg, "runtime")
    };
  }

  private async materializeFiles(
    configDirectory: string,
    root: string,
    mappings: NonNullable<ProfileIsolationConfig["files"]>
  ): Promise<MaterializedFile[]> {
    const destinations = new Set<string>();
    const environments = new Set<string>();
    const prepared = await Promise.all(
      mappings.map(async (mapping) => {
        const destinationSegments = safeRelativeSegments(mapping.destination);
        const destinationKey = this.pathKey(destinationSegments);
        if (destinationKey === markerName || destinations.has(destinationKey)) throw isolationFailure();
        destinations.add(destinationKey);
        if (mapping.environment !== undefined) {
          const environmentKey = mapping.environment.toUpperCase();
          if (environments.has(environmentKey)) throw isolationFailure();
          environments.add(environmentKey);
        }
        const source = await this.readSource(configDirectory, mapping.source);
        return { destinationSegments, environment: mapping.environment, source };
      })
    );

    const materialized: MaterializedFile[] = [];
    for (const entry of prepared) {
      const destination = await this.writeDestination(root, entry.destinationSegments, entry.source.content);
      this.options.redactor.add(entry.source.text);
      materialized.push({ destination, environment: entry.environment });
    }
    return materialized;
  }

  private async readSource(configDirectory: string, value: string): Promise<{ content: Buffer; text: string }> {
    const segments = safeRelativeSegments(value);
    let path = configDirectory;
    let sourceEntry: Awaited<ReturnType<typeof lstat>> | undefined;
    for (const [index, segment] of segments.entries()) {
      path = join(path, segment);
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) throw isolationFailure();
      if (index < segments.length - 1 && !entry.isDirectory()) throw isolationFailure();
      if (index === segments.length - 1) {
        if (!entry.isFile()) throw isolationFailure();
        sourceEntry = entry;
      }
    }
    if (!isWithin(configDirectory, path) || sourceEntry === undefined || sourceEntry.size > maximumMappedFileBytes) {
      throw isolationFailure();
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let content: Buffer;
    try {
      handle = await open(path, "r");
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.size > maximumMappedFileBytes ||
        opened.dev !== sourceEntry.dev ||
        opened.ino !== sourceEntry.ino
      ) {
        throw isolationFailure();
      }
      content = await handle.readFile();
    } finally {
      await handle?.close();
    }
    if (content.byteLength > maximumMappedFileBytes) throw isolationFailure();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw isolationFailure();
    }
    return { content, text };
  }

  private async writeDestination(root: string, segments: readonly string[], content: Buffer): Promise<string> {
    const fileName = segments.at(-1);
    if (fileName === undefined) throw isolationFailure();
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      directory = await ensureOwnedDirectory(directory, segment);
    }
    const destination = join(directory, fileName);
    await assertSafeReplacementTarget(destination);
    const temporary = join(directory, `.${basename(fileName)}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await setRestrictiveMode(temporary, 0o600);
      await rename(temporary, destination);
      await setRestrictiveMode(destination, 0o600);
      return destination;
    } catch {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw isolationFailure();
    }
  }

  private pathKey(segments: readonly string[]): string {
    const normalized =
      this.platform === "win32"
        ? segments.map((segment) => segment.replace(/[. ]+$/u, "").toLocaleLowerCase("en-US"))
        : [...segments];
    if (normalized.some((segment) => segment.length === 0)) throw isolationFailure();
    return normalized.join("/");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeRelativeSegments(value: string): string[] {
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw isolationFailure();
  }
  const segments = value.split(/[\\/]/u);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw isolationFailure();
  }
  return segments;
}

async function ensureOwnedDirectory(parent: string, segment: string): Promise<string> {
  return (await ensureOwnedDirectoryState(parent, segment)).path;
}

async function ensureOwnedDirectoryState(parent: string, segment: string): Promise<{ path: string; created: boolean }> {
  const directory = join(parent, segment);
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw isolationFailure();
  await setRestrictiveMode(directory, 0o700);
  return { path: directory, created };
}

async function ensureMarker(
  directory: string,
  expected: { readonly version: string; readonly configIdentity: string; readonly targetIdentity: string },
  directoryCreated: boolean
): Promise<void> {
  const marker = join(directory, markerName);
  const serialized = JSON.stringify(expected);
  if (!directoryCreated) {
    await assertExpectedMarker(marker, serialized);
    return;
  }
  try {
    const handle = await open(marker, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await setRestrictiveMode(marker, 0o600);
    return;
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  await assertExpectedMarker(marker, serialized);
}

async function assertExpectedMarker(marker: string, serialized: string): Promise<void> {
  const entry = await lstat(marker);
  if (!entry.isFile() || entry.isSymbolicLink()) throw isolationFailure();
  const existing = await readFile(marker, "utf8");
  if (existing !== serialized) throw isolationFailure();
  await setRestrictiveMode(marker, 0o600);
}

async function assertSafeReplacementTarget(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw isolationFailure();
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function setRestrictiveMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (!isErrorCode(error, "ENOSYS") && !isErrorCode(error, "ENOTSUP") && !isErrorCode(error, "EOPNOTSUPP")) {
      throw error;
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && !path.startsWith("..");
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isolationFailure(): MiftahError {
  return new MiftahError("UPSTREAM_START_FAILED", "UPSTREAM_START_FAILED: profile runtime isolation could not be prepared");
}
