import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { ProfileIsolationConfig, ProfileIsolationContainerVolume, TransportType } from "../config/types.js";
import { SecretRedactor } from "../secrets/redact.js";
import { MiftahError } from "../utils/errors.js";

const maximumMappedFileBytes = 1_048_576;
const markerName = ".miftah-profile-isolation.json";
const runtimeVersion = "v1";
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const trailingWindowsPathSuffixPattern = /[. ]+$/u;
const shortContainerEnvironmentOrVolumeFlagPattern = /[ev]/iu;
const windowsDrivePrefixPattern = /^[A-Za-z]:/u;
const pathSegmentSeparatorPattern = /[\\/]/u;
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
  readonly args: string[];
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
  private configContext: Promise<{ readonly configPath: string; readonly configDirectory: string }> | undefined;

  constructor(private readonly options: ProfileRuntimeIsolationOptions) {
    this.platform = options.platform ?? process.platform;
    this.ownerUid =
      this.platform === "win32" || typeof process.getuid !== "function" ? undefined : (options.ownerUid ?? process.getuid());
  }

  async prepare(
    profile: string,
    upstreamName: string,
    isolation: ProfileIsolationConfig | undefined,
    transport: TransportType,
    command?: string,
    args: readonly string[] = [],
    containerEnvironment: Readonly<Record<string, string | undefined>> = process.env
  ): Promise<PreparedProfileRuntimeIsolation> {
    if (isolation === undefined) return { environment: {}, args: [...args], suppressStderr: false };
    if (transport !== "stdio") throw isolationFailure();
    // Node mode bits cannot install or verify a restrictive Windows DACL. Refuse before materializing any credential.
    if (this.platform === "win32") throw isolationFailure();

    try {
      assertProfileIsolationBindings(isolation);
      const { configPath, configDirectory } = await this.getConfigContext();
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
      const containerVolumes = isolation.containerVolumes ?? [];
      const preparedArgs =
        containerVolumes.length === 0
          ? [...args]
          : await buildContainerIsolationArguments(command, args, root, containerVolumes, containerEnvironment, this.platform);
      return { environment, args: preparedArgs, suppressStderr: files.length > 0 || containerVolumes.length > 0 };
    } catch {
      throw isolationFailure();
    }
  }

  private getConfigContext(): Promise<{ readonly configPath: string; readonly configDirectory: string }> {
    this.configContext ??= this.resolveCanonicalConfigPath().then((configPath) => ({
      configPath,
      configDirectory: dirname(configPath)
    }));
    return this.configContext;
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
      if (index < segments.length - 1 && !isTrustedSourceDirectory(entry, this.ownerUid)) throw isolationFailure();
      if (index === segments.length - 1) {
        if (!isTrustedSourceFile(entry, this.ownerUid)) throw isolationFailure();
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
        !isTrustedSourceFile(opened, this.ownerUid) ||
        opened.size > maximumMappedFileBytes ||
        opened.dev !== sourceEntry.dev ||
        opened.ino !== sourceEntry.ino ||
        !isWithin(configDirectory, canonicalSource) ||
        !isTrustedSourceFile(canonicalEntry, this.ownerUid) ||
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
      this.platform === "win32" || this.platform === "darwin"
        ? segments.map((segment) => segment.replace(trailingWindowsPathSuffixPattern, "").toLocaleLowerCase("en-US"))
        : [...segments];
    if (normalized.some((segment) => segment.length === 0)) throw isolationFailure();
    return normalized.join("/");
  }
}

/**
 * Produces fixed Docker/Podman `run` arguments for paths inside one prepared runtime tree.
 * It accepts only explicit argument arrays; callers must never interpolate the result into a shell command.
 */
export async function buildContainerIsolationArguments(
  command: string | undefined,
  args: readonly string[],
  root: string,
  volumes: readonly ProfileIsolationContainerVolume[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<string[]> {
  const engine = containerEngine(command);
  if (engine === undefined || args[0] !== "run") throw isolationFailure();
  assertLocalContainerEngine(engine, environment, platform);
  const runtimeRoot = await verifyContainerRuntimeRoot(root);
  const canonicalRoot = runtimeRoot.path;
  const bindings = new Map<string, { name: string; destination: string }>();
  const destinations = new Set<string>();
  const generatedVolumes: Array<{
    mount: string;
    source: { path: string; entry: Awaited<ReturnType<typeof stat>> };
    sourceValue: string;
    bindings: Array<{ name: string; destination: string }>;
  }> = [];

  for (const volume of volumes) {
    const source = await resolveContainerVolumeSource(canonicalRoot, volume.source);
    const destination = safeContainerDestination(volume.destination);
    if (destinations.has(destination)) throw isolationFailure();
    destinations.add(destination);
    const volumeBindings: Array<{ name: string; destination: string }> = [];
    for (const name of runtimeEnvironmentNamesForSource(volume.source)) {
      volumeBindings.push(addContainerBinding(bindings, name, destination, true));
    }
    if (volume.environment !== undefined) {
      volumeBindings.push(addContainerBinding(bindings, volume.environment, destination, false));
    }
    generatedVolumes.push({
      mount: `type=bind,src=${source.path},dst=${destination}${volume.readOnly === false ? "" : ",readonly"}`,
      source,
      sourceValue: volume.source,
      bindings: volumeBindings
    });
  }

  assertNoConflictingContainerArguments(args, bindings);
  await verifyContainerRuntimeRoot(root, runtimeRoot.entry);
  for (const volume of generatedVolumes) {
    await resolveContainerVolumeSource(canonicalRoot, volume.sourceValue, volume.source.entry);
  }
  const generated: string[] = [];
  for (const volume of generatedVolumes) {
    generated.push("--mount", volume.mount);
    for (const { name, destination } of volume.bindings) {
      generated.push("--env", `${name}=${destination}`);
    }
  }
  return ["run", ...generated, ...args.slice(1)];
}

/** Validates bindings after profile and named-upstream isolation objects have been combined. */
export function assertProfileIsolationBindings(isolation: ProfileIsolationConfig): void {
  const bindings = new Map<string, { kind: "file" | "volume"; destination: string }>();
  const volumeEnvironmentNames = new Set<string>();
  for (const file of isolation.files ?? []) {
    if (file.environment === undefined) continue;
    addProfileIsolationBinding(bindings, file.environment, "file", file.destination);
  }
  for (const volume of isolation.containerVolumes ?? []) {
    if (volume.environment === undefined) continue;
    const key = volume.environment.toLocaleUpperCase("en-US");
    if (
      !environmentNamePattern.test(volume.environment) ||
      generatedEnvironmentNames.has(key) ||
      volumeEnvironmentNames.has(key)
    ) {
      throw isolationFailure();
    }
    volumeEnvironmentNames.add(key);
    const existing = bindings.get(key);
    if (existing === undefined) {
      bindings.set(key, { kind: "volume", destination: volume.destination });
      continue;
    }
    if (existing.kind !== "file" || existing.destination !== volume.source) throw isolationFailure();
  }
}

function addProfileIsolationBinding(
  bindings: Map<string, { kind: "file" | "volume"; destination: string }>,
  environment: string,
  kind: "file" | "volume",
  destination: string
): void {
  const key = environment.toLocaleUpperCase("en-US");
  if (!environmentNamePattern.test(environment) || generatedEnvironmentNames.has(key) || bindings.has(key)) {
    throw isolationFailure();
  }
  bindings.set(key, { kind, destination });
}

function containerEngine(command: string | undefined): "docker" | "podman" | undefined {
  if (command === undefined) return undefined;
  const executable = command.replaceAll("\\", "/").split("/").at(-1)?.toLocaleLowerCase("en-US");
  if (executable === "docker" || executable === "docker.exe") return "docker";
  if (executable === "podman" || executable === "podman.exe") return "podman";
  return undefined;
}

function assertLocalContainerEngine(
  engine: "docker" | "podman",
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): void {
  if (engine === "podman" && platform === "darwin") throw isolationFailure();
  const remoteKeys =
    engine === "docker"
      ? ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]
      : [
          "CONTAINER_HOST",
          "CONTAINER_CONNECTION",
          "PODMAN_CONNECTIONS_CONF",
          "CONTAINERS_CONF",
          "DOCKER_HOST",
          "DOCKER_CONTEXT",
          "DOCKER_CONFIG"
        ];
  if (remoteKeys.some((key) => environmentValue(environment, key) !== undefined)) throw isolationFailure();
}

function environmentValue(environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const normalizedName = name.toLocaleUpperCase("en-US");
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLocaleUpperCase("en-US") === normalizedName && value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

async function verifyContainerRuntimeRoot(
  root: string,
  expected?: Awaited<ReturnType<typeof lstat>>
): Promise<{ path: string; entry: Awaited<ReturnType<typeof lstat>> }> {
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (expected !== undefined && !sameEntry(expected, entry))) {
    throw isolationFailure();
  }
  const canonicalRoot = await realpath(root);
  const canonicalEntry = await lstat(canonicalRoot);
  if (!canonicalEntry.isDirectory() || canonicalEntry.isSymbolicLink() || !sameEntry(entry, canonicalEntry)) {
    throw isolationFailure();
  }
  await verifyOwnedDirectory(canonicalRoot, canonicalRoot, undefined);
  return { path: canonicalRoot, entry: canonicalEntry };
}

async function resolveContainerVolumeSource(
  root: string,
  value: string,
  expected?: Awaited<ReturnType<typeof stat>>
): Promise<{ path: string; entry: Awaited<ReturnType<typeof stat>> }> {
  const segments = safeContainerRelativeSegments(value);
  let path = root;
  let sourceEntry: Awaited<ReturnType<typeof lstat>> | undefined;
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw isolationFailure();
    if (index < segments.length - 1 && !entry.isDirectory()) throw isolationFailure();
    if (index === segments.length - 1) {
      if (!entry.isDirectory() && !entry.isFile()) throw isolationFailure();
      sourceEntry = entry;
    }
  }
  if (sourceEntry === undefined || !isWithin(root, path)) throw isolationFailure();
  const canonicalSource = await realpath(path);
  const canonicalEntry = await stat(canonicalSource);
  if (
    (!canonicalEntry.isDirectory() && !canonicalEntry.isFile()) ||
    !sameEntry(sourceEntry, canonicalEntry) ||
    !isWithin(root, canonicalSource) ||
    (expected !== undefined && !sameEntry(expected, canonicalEntry)) ||
    canonicalSource.includes(",")
  ) {
    throw isolationFailure();
  }
  return { path: canonicalSource, entry: canonicalEntry };
}

function safeContainerRelativeSegments(value: string): string[] {
  const segments = safeRelativeSegments(value);
  if (segments.some((segment) => segment.includes(","))) throw isolationFailure();
  return segments;
}

function safeContainerDestination(value: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\u0000") ||
    value.includes(",") ||
    value.includes("\\") ||
    !value.startsWith("/")
  ) {
    throw isolationFailure();
  }
  const segments = value.split("/");
  if (segments.length < 2 || segments[0] !== "" || segments.slice(1).some((segment) => !segment || segment === "." || segment === "..")) {
    throw isolationFailure();
  }
  return value;
}

function runtimeEnvironmentNamesForSource(source: string): readonly string[] {
  switch (source) {
    case "home":
      return ["HOME", "USERPROFILE"];
    case "appdata":
      return ["APPDATA"];
    case "localappdata":
      return ["LOCALAPPDATA"];
    case "xdg/config":
      return ["XDG_CONFIG_HOME"];
    case "xdg/cache":
      return ["XDG_CACHE_HOME"];
    case "xdg/data":
      return ["XDG_DATA_HOME"];
    case "xdg/state":
      return ["XDG_STATE_HOME"];
    case "xdg/runtime":
      return ["XDG_RUNTIME_DIR"];
    default:
      return [];
  }
}

function addContainerBinding(
  bindings: Map<string, { name: string; destination: string }>,
  name: string,
  destination: string,
  managedRuntimeBinding: boolean
): { name: string; destination: string } {
  const key = name.toLocaleUpperCase("en-US");
  if (!environmentNamePattern.test(name) || (!managedRuntimeBinding && generatedEnvironmentNames.has(key)) || bindings.has(key)) {
    throw isolationFailure();
  }
  const binding = { name, destination };
  bindings.set(key, binding);
  return binding;
}

function assertNoConflictingContainerArguments(
  args: readonly string[],
  generatedBindings: ReadonlyMap<string, { name: string; destination: string }>
): void {
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    const environment = containerEnvironmentArgument(args, index);
    if (environment !== undefined) {
      if (generatedBindings.has(environment.name.toLocaleUpperCase("en-US"))) throw isolationFailure();
      index += environment.consumed;
      continue;
    }
    if (isContainerMountArgument(argument) || isContainerEnvironmentFileArgument(argument)) throw isolationFailure();
  }
}

function isContainerMountArgument(argument: string): boolean {
  return (
    argument === "--mount" ||
    argument.startsWith("--mount=") ||
    argument === "--volume" ||
    argument.startsWith("--volume=") ||
    argument === "--volumes-from" ||
    argument.startsWith("--volumes-from=") ||
    argument === "--tmpfs" ||
    argument.startsWith("--tmpfs=") ||
    argument === "--device" ||
    argument.startsWith("--device=") ||
    argument === "-v" ||
    (argument.startsWith("-v") && argument.length > 2) ||
    (argument.startsWith("-") && !argument.startsWith("--") && shortContainerEnvironmentOrVolumeFlagPattern.test(argument.slice(1)))
  );
}

function isContainerEnvironmentFileArgument(argument: string): boolean {
  return argument === "--env-file" || argument.startsWith("--env-file=");
}

function containerEnvironmentArgument(
  args: readonly string[],
  index: number
): { name: string; consumed: number } | undefined {
  const argument = args[index]!;
  let value: string | undefined;
  let consumed = 0;
  if (argument === "--env" || argument === "-e") {
    value = args[index + 1];
    consumed = 1;
  } else if (argument.startsWith("--env=")) {
    value = argument.slice("--env=".length);
  } else if (argument.startsWith("-e=")) {
    value = argument.slice("-e=".length);
  } else if (argument.startsWith("-e") && argument.length > 2) {
    value = argument.slice(2);
  } else {
    return undefined;
  }
  const name = value?.split("=", 1)[0];
  if (name === undefined || name.length === 0) throw isolationFailure();
  return { name, consumed };
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
    windowsDrivePrefixPattern.test(value)
  ) {
    throw isolationFailure();
  }
  const segments = value.split(pathSegmentSeparatorPattern);
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
  await chmod(path, mode);
}

async function setHandleRestrictiveMode(handle: Awaited<ReturnType<typeof open>>, mode: number): Promise<void> {
  await handle.chmod(mode);
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

function isTrustedSourceFile(
  entry: Pick<Awaited<ReturnType<typeof stat>>, "isFile" | "mode" | "uid">,
  ownerUid: number | undefined
): boolean {
  return entry.isFile() && hasExpectedOwner(entry, ownerUid) && (Number(entry.mode) & 0o022) === 0;
}

function isTrustedSourceDirectory(
  entry: Pick<Awaited<ReturnType<typeof stat>>, "isDirectory" | "mode" | "uid">,
  ownerUid: number | undefined
): boolean {
  return entry.isDirectory() && hasExpectedOwner(entry, ownerUid) && (Number(entry.mode) & 0o022) === 0;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isolationFailure(): MiftahError {
  return new MiftahError("UPSTREAM_START_FAILED", "UPSTREAM_START_FAILED: profile runtime isolation could not be prepared");
}
