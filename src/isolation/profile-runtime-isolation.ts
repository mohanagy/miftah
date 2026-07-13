import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { ProfileIsolationConfig, TransportType } from "../config/types.js";
import { SecretRedactor } from "../secrets/redact.js";
import { MiftahError } from "../utils/errors.js";

const maximumMappedFileBytes = 1_048_576;
const markerName = ".miftah-profile-isolation.json";
const runtimeVersion = "v1";
const generatedEnvironmentNames = new Set([
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR"
]);

export interface ProfileRuntimeIsolationOptions {
  readonly configPath: string;
  readonly redactor: SecretRedactor;
  /** Internal test seam for platform-specific filesystem behavior. */
  readonly platform?: NodeJS.Platform;
  /** Internal test seam for POSIX runtime-tree ownership checks. */
  readonly ownerUid?: number;
}

export interface PreparedProfileRuntimeIsolation {
  readonly environment: Record<string, string>;
  /** Fail closed for child diagnostics when copied credential material can be re-formatted by the child. */
  readonly suppressStderr: boolean;
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
  private readonly ownerUid: number | undefined;
  private readonly canonicalConfigPath: Promise<string>;
  private readonly configDirectory: Promise<string>;

  constructor(private readonly options: ProfileRuntimeIsolationOptions) {
    this.platform = options.platform ?? process.platform;
    this.ownerUid =
      this.platform === "win32" || typeof process.getuid !== "function" ? undefined : (options.ownerUid ?? process.getuid());
    this.canonicalConfigPath = this.resolveCanonicalConfigPath();
    this.configDirectory = this.canonicalConfigPath.then((configPath) => dirname(configPath));
  }

  async prepare(
    profile: string,
    upstreamName: string,
    isolation: ProfileIsolationConfig | undefined,
    transport: TransportType
  ): Promise<PreparedProfileRuntimeIsolation> {
    if (isolation === undefined) return { environment: {}, suppressStderr: false };
    if (transport !== "stdio") throw isolationFailure();
    if ((isolation.containerVolumes?.length ?? 0) > 0) throw isolationFailure();

    try {
      const [configPath, configDirectory] = await Promise.all([this.canonicalConfigPath, this.configDirectory]);
      const root = await this.ensureRuntimeRoot(configDirectory, configPath, profile, upstreamName);
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
      return { environment, suppressStderr: files.length > 0 };
    } catch {
      throw isolationFailure();
    }
  }

  private async resolveCanonicalConfigPath(): Promise<string> {
    try {
      return await realpath(this.options.configPath);
    } catch {
      throw isolationFailure();
    }
  }

  private async ensureRuntimeRoot(
    configDirectory: string,
    configPath: string,
    profile: string,
    upstreamName: string
  ): Promise<string> {
    const configIdentity = hash(configPath);
    const targetIdentity = hash(`${profile}\u0000${upstreamName}`);
    const trustedConfigDirectory = await ensureTrustedConfigDirectory(configDirectory, this.ownerUid);
    let current = trustedConfigDirectory;
    let targetCreated = false;
    const segments = [".miftah", "runtime", runtimeVersion, configIdentity, targetIdentity];
    for (const [index, segment] of segments.entries()) {
      const directory = await ensureOwnedDirectoryState(current, segment, trustedConfigDirectory, this.ownerUid);
      current = directory.path;
      if (index === segments.length - 1) targetCreated = directory.created;
    }
    await ensureMarker(
      current,
      { version: runtimeVersion, configIdentity, targetIdentity },
      targetCreated,
      current,
      this.ownerUid
    );
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
    const home = await ensureOwnedDirectory(root, "home", root, this.ownerUid);
    const appData = await ensureOwnedDirectory(root, "appdata", root, this.ownerUid);
    const localAppData = await ensureOwnedDirectory(root, "localappdata", root, this.ownerUid);
    const xdg = await ensureOwnedDirectory(root, "xdg", root, this.ownerUid);
    return {
      home,
      appData,
      localAppData,
      xdgConfig: await ensureOwnedDirectory(xdg, "config", root, this.ownerUid),
      xdgCache: await ensureOwnedDirectory(xdg, "cache", root, this.ownerUid),
      xdgData: await ensureOwnedDirectory(xdg, "data", root, this.ownerUid),
      xdgState: await ensureOwnedDirectory(xdg, "state", root, this.ownerUid),
      xdgRuntime: await ensureOwnedDirectory(xdg, "runtime", root, this.ownerUid)
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
          const environmentKey = mapping.environment.toLocaleUpperCase("en-US");
          if (generatedEnvironmentNames.has(environmentKey) || environments.has(environmentKey)) throw isolationFailure();
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
      this.options.redactor.add(destination);
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
      const canonicalSource = await realpath(path);
      const canonicalEntry = await stat(canonicalSource);
      if (
        !opened.isFile() ||
        opened.size > maximumMappedFileBytes ||
        opened.dev !== sourceEntry.dev ||
        opened.ino !== sourceEntry.ino ||
        !isWithin(configDirectory, canonicalSource) ||
        !canonicalEntry.isFile() ||
        canonicalEntry.dev !== sourceEntry.dev ||
        canonicalEntry.ino !== sourceEntry.ino
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
    let directory = (await verifyOwnedDirectory(root, root, this.ownerUid)).path;
    for (const segment of segments.slice(0, -1)) {
      directory = await ensureOwnedDirectory(directory, segment, root, this.ownerUid);
    }
    const destination = join(directory, fileName);
    await assertSafeReplacementTarget(destination, root, this.ownerUid);
    const temporary = join(directory, `.${basename(fileName)}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryEntry: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await setHandleRestrictiveMode(handle, 0o600);
      temporaryEntry = await handle.stat();
      await verifyOpenedRegularFile(handle, temporary, root, this.ownerUid);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      if ((await verifyOwnedDirectory(root, root, this.ownerUid)).path !== root) throw isolationFailure();
      if ((await verifyOwnedDirectory(directory, root, this.ownerUid)).path !== directory) throw isolationFailure();
      await assertSafeReplacementTarget(destination, root, this.ownerUid);
      await rename(temporary, destination);
      return (await verifyRegularFile(destination, root, temporaryEntry, this.ownerUid)).path;
    } catch {
      await handle?.close();
      if (temporaryEntry !== undefined) await removeVerifiedTemporary(temporary, root, temporaryEntry, this.ownerUid);
      throw isolationFailure();
    }
  }

  private pathKey(segments: readonly string[]): string {
    const normalized =
      segments.map((segment) => segment.replace(/[. ]+$/u, "").toLocaleLowerCase("en-US"));
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

async function ensureOwnedDirectory(
  parent: string,
  segment: string,
  boundary: string,
  ownerUid: number | undefined
): Promise<string> {
  return (await ensureOwnedDirectoryState(parent, segment, boundary, ownerUid)).path;
}

async function ensureOwnedDirectoryState(
  parent: string,
  segment: string,
  boundary: string,
  ownerUid: number | undefined
): Promise<{ path: string; created: boolean }> {
  const canonicalParent = (await verifyOwnedDirectory(parent, boundary, ownerUid)).path;
  const directory = join(canonicalParent, segment);
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  const verified = await verifyOwnedDirectory(directory, boundary, ownerUid);
  await setRestrictiveMode(verified.path, 0o700);
  const revalidated = await verifyOwnedDirectory(verified.path, boundary, ownerUid);
  if (!sameEntry(verified.entry, revalidated.entry)) throw isolationFailure();
  return { path: revalidated.path, created };
}

async function ensureMarker(
  directory: string,
  expected: { readonly version: string; readonly configIdentity: string; readonly targetIdentity: string },
  directoryCreated: boolean,
  boundary: string,
  ownerUid: number | undefined
): Promise<void> {
  const marker = join(directory, markerName);
  const serialized = JSON.stringify(expected);
  if (!directoryCreated) {
    await assertExpectedMarker(marker, serialized, boundary, ownerUid);
    return;
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(marker, "wx", 0o600);
    try {
      await setHandleRestrictiveMode(handle, 0o600);
      await verifyOpenedRegularFile(handle, marker, boundary, ownerUid);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
      handle = undefined;
    }
    return;
  } catch (error) {
    await handle?.close();
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  await assertExpectedMarker(marker, serialized, boundary, ownerUid);
}

async function assertExpectedMarker(
  marker: string,
  serialized: string,
  boundary: string,
  ownerUid: number | undefined
): Promise<void> {
  const expected = await verifyRegularFile(marker, boundary, undefined, ownerUid);
  const handle = await open(expected.path, "r");
  try {
    await verifyOpenedRegularFile(handle, expected.path, boundary, ownerUid, expected.entry);
    const existing = await handle.readFile("utf8");
    if (existing !== serialized) throw isolationFailure();
    await setHandleRestrictiveMode(handle, 0o600);
  } finally {
    await handle.close();
  }
}

async function assertSafeReplacementTarget(path: string, boundary: string, ownerUid: number | undefined): Promise<void> {
  try {
    await verifyRegularFile(path, boundary, undefined, ownerUid);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function ensureTrustedConfigDirectory(configDirectory: string, ownerUid: number | undefined): Promise<string> {
  const verified = await verifyOwnedDirectory(configDirectory, configDirectory, ownerUid);
  if (ownerUid !== undefined && (Number(verified.entry.mode) & 0o022) !== 0) throw isolationFailure();
  return verified.path;
}

async function verifyOwnedDirectory(
  directory: string,
  boundary: string,
  ownerUid: number | undefined
): Promise<{ path: string; entry: Awaited<ReturnType<typeof lstat>> }> {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !hasExpectedOwner(entry, ownerUid)) throw isolationFailure();
  const canonicalDirectory = await realpath(directory);
  const canonicalEntry = await lstat(canonicalDirectory);
  if (
    !canonicalEntry.isDirectory() ||
    canonicalEntry.isSymbolicLink() ||
    !hasExpectedOwner(canonicalEntry, ownerUid) ||
    !sameEntry(entry, canonicalEntry) ||
    !isWithinOrSame(boundary, canonicalDirectory)
  ) {
    throw isolationFailure();
  }
  return { path: canonicalDirectory, entry: canonicalEntry };
}

async function verifyRegularFile(
  path: string,
  boundary: string,
  expected: Awaited<ReturnType<typeof stat>> | undefined,
  ownerUid: number | undefined
): Promise<{ path: string; entry: Awaited<ReturnType<typeof stat>> }> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || !hasExpectedOwner(entry, ownerUid)) throw isolationFailure();
  const canonicalPath = await realpath(path);
  const canonicalEntry = await stat(canonicalPath);
  if (
    !canonicalEntry.isFile() ||
    !hasExpectedOwner(canonicalEntry, ownerUid) ||
    !sameEntry(entry, canonicalEntry) ||
    (expected !== undefined && !sameEntry(expected, canonicalEntry)) ||
    !isWithin(boundary, canonicalPath)
  ) {
    throw isolationFailure();
  }
  return { path: canonicalPath, entry: canonicalEntry };
}

async function verifyOpenedRegularFile(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
  boundary: string,
  ownerUid: number | undefined,
  expected?: Awaited<ReturnType<typeof stat>>
): Promise<{ path: string; entry: Awaited<ReturnType<typeof stat>> }> {
  const opened = await handle.stat();
  if (
    !opened.isFile() ||
    !hasExpectedOwner(opened, ownerUid) ||
    (expected !== undefined && !sameEntry(opened, expected))
  ) {
    throw isolationFailure();
  }
  return verifyRegularFile(path, boundary, expected ?? opened, ownerUid);
}

async function removeVerifiedTemporary(
  path: string,
  boundary: string,
  expected: Awaited<ReturnType<typeof stat>>,
  ownerUid: number | undefined
): Promise<void> {
  try {
    const verified = await verifyRegularFile(path, boundary, expected, ownerUid);
    await rm(verified.path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function setRestrictiveMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (!isUnsupportedPermissionOperation(error)) {
      throw error;
    }
  }
}

async function setHandleRestrictiveMode(handle: Awaited<ReturnType<typeof open>>, mode: number): Promise<void> {
  try {
    await handle.chmod(mode);
  } catch (error) {
    if (!isUnsupportedPermissionOperation(error)) throw error;
  }
}

function isUnsupportedPermissionOperation(error: unknown): boolean {
  return isErrorCode(error, "ENOSYS") || isErrorCode(error, "ENOTSUP") || isErrorCode(error, "EOPNOTSUPP");
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

function isWithinOrSame(parent: string, child: string): boolean {
  return parent === child || isWithin(parent, child);
}

function sameEntry(
  first: Pick<Awaited<ReturnType<typeof stat>>, "dev" | "ino">,
  second: Pick<Awaited<ReturnType<typeof stat>>, "dev" | "ino">
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function hasExpectedOwner(entry: Pick<Awaited<ReturnType<typeof stat>>, "uid">, ownerUid: number | undefined): boolean {
  return ownerUid === undefined || entry.uid === ownerUid;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isolationFailure(): MiftahError {
  return new MiftahError("UPSTREAM_START_FAILED", "UPSTREAM_START_FAILED: profile runtime isolation could not be prepared");
}
