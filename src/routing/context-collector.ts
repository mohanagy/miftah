import { execFile as execFileCallback } from "node:child_process";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { redactUri } from "../secrets/redact.js";
import { MiftahError } from "../utils/errors.js";
import { githubRepositoryFromSource } from "./provider-matchers.js";
import type {
  RoutingContextCollectorInput,
  RoutingContextEvidence,
  RoutingContextMcpRoot,
  RoutingContextProfileHint,
  RoutingContextSnapshot
} from "./routing-types.js";
import type { ProviderMatcherContext } from "./provider-matcher-types.js";

const execFile = promisify(execFileCallback);

/** Maximum bytes read from a known JSON metadata file before it is ignored. */
export const MAX_ROUTING_CONTEXT_JSON_BYTES = 64 * 1024;
const uriSchemePattern = /^[a-z][a-z0-9+.-]*:/i;
const windowsDrivePattern = /^[a-z]:[\\/]/i;

interface ProjectMarker {
  readonly profile: string;
  readonly path: string;
}

interface PackageMetadata {
  readonly path: string;
  readonly name?: string;
  readonly repository?: string;
  readonly githubRepository?: string;
  readonly workspace: boolean;
}

interface GitOrigin {
  readonly origin: string;
  readonly githubRepository?: string;
}

interface KnownJsonFile {
  readonly found: boolean;
  readonly value?: unknown;
}

/**
 * Collects bounded, allowlisted metadata for later routing decisions.
 * It does not select a profile or load runtime configuration.
 */
export async function collectRoutingContext(
  input: RoutingContextCollectorInput
): Promise<RoutingContextSnapshot> {
  const cwd = resolve(input.cwd);
  const fileRoots = normalizeFileRoots(input.mcpRoots ?? []);
  const boundary = selectBoundary(cwd, fileRoots);
  const metadataScope = await resolveMetadataScope(cwd, boundary);
  const environment = collectEnvironment(input.environment);
  const marker = metadataScope
    ? await findProjectMarker(
        metadataScope.cwd,
        metadataScope.boundary,
        input.wrapperName,
        input.runtimeConfigPath,
        input.knownProfileNames
      )
    : undefined;
  const packages = metadataScope
    ? await findPackageMetadata(metadataScope.cwd, metadataScope.boundary)
    : {};
  const gitOrigin = metadataScope
    ? await findGitOrigin(
        metadataScope.cwd,
        metadataScope.boundary,
        input.gitExecutable ?? "git"
      )
    : undefined;

  const hints: RoutingContextProfileHint[] = [];
  if (environment.profile !== undefined) {
    assertKnownProfile(environment.profile, input.knownProfileNames);
    hints.push({
      profile: environment.profile,
      source: "environment",
      evidence: { kind: "environment", variable: "MIFTAH_PROFILE" }
    });
  }
  if (marker) {
    hints.push({
      profile: marker.profile,
      source: "project-marker",
      evidence: { kind: "marker", path: marker.path }
    });
  }

  const context: Record<string, unknown> = { cwd, fileRoots };
  if (environment.profile !== undefined || environment.project !== undefined) {
    context.environment = {
      ...(environment.profile === undefined ? {} : { profile: environment.profile }),
      ...(environment.project === undefined ? {} : { project: environment.project })
    };
  }
  if (marker) context.marker = { profile: marker.profile };
  if (packages.nearest) context.package = contextPackage(packages.nearest);
  if (packages.workspace) context.workspace = contextPackage(packages.workspace);
  if (gitOrigin) context.git = { origin: gitOrigin.origin };

  const evidence: RoutingContextEvidence = {
    cwd,
    fileRoots,
    ...(environment.profile === undefined && environment.project === undefined
      ? {}
      : {
          environment: {
            ...(environment.profile === undefined ? {} : { profile: environment.profile }),
            ...(environment.project === undefined ? {} : { hasProject: true as const })
          }
        }),
    ...(marker ? { marker: { path: marker.path } } : {}),
    ...(packages.nearest ? { package: evidencePackage(packages.nearest) } : {}),
    ...(packages.workspace ? { workspace: evidencePackage(packages.workspace) } : {}),
    ...(gitOrigin ? { git: { origin: gitOrigin.origin } } : {})
  };
  const matcherContext = providerMatcherContext(packages, gitOrigin);

  return deepFreeze({ context, evidence, profileHints: hints, ...(matcherContext ? { matcherContext } : {}) });
}

function collectEnvironment(environment: Readonly<Record<string, string | undefined>>): {
  profile?: string;
  project?: string;
} {
  return {
    ...(environment.MIFTAH_PROFILE === undefined ? {} : { profile: environment.MIFTAH_PROFILE }),
    ...(environment.MIFTAH_PROJECT === undefined
      ? {}
      : { project: redactProjectValue(environment.MIFTAH_PROJECT) })
  };
}

function redactProjectValue(value: string): string {
  if (uriSchemePattern.test(value) && !windowsDrivePattern.test(value)) {
    return redactUri(value);
  }
  return value;
}

function normalizeFileRoots(roots: readonly (string | RoutingContextMcpRoot)[]): string[] {
  const normalized = new Set<string>();
  for (const root of roots) {
    const uri = typeof root === "string" ? root : root.uri;
    if (typeof uri !== "string") continue;
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "file:") continue;
      parsed.search = "";
      parsed.hash = "";
      const path = resolve(fileURLToPath(parsed));
      normalized.add(pathToFileURL(path).toString());
    } catch {
      // Client-provided root metadata is optional and malformed roots are ignored.
    }
  }
  return [...normalized].sort();
}

function selectBoundary(cwd: string, fileRootUris: readonly string[]): string {
  const candidates = fileRootUris
    .map((uri) => fileURLToPath(uri))
    .filter((root) => isWithin(root, cwd))
    .sort((first, second) => second.length - first.length);
  return candidates[0] ?? cwd;
}

async function resolveMetadataScope(
  cwd: string,
  boundary: string
): Promise<{ cwd: string; boundary: string } | undefined> {
  try {
    const [resolvedCwd, resolvedBoundary] = await Promise.all([realpath(cwd), realpath(boundary)]);
    return isWithin(resolvedBoundary, resolvedCwd)
      ? { cwd: resolvedCwd, boundary: resolvedBoundary }
      : undefined;
  } catch {
    return undefined;
  }
}

async function findProjectMarker(
  cwd: string,
  boundary: string,
  wrapperName: string,
  runtimeConfigPath: string | undefined,
  knownProfileNames: readonly string[]
): Promise<ProjectMarker | undefined> {
  const runtimePath = runtimeConfigPath ? await canonicalPath(runtimeConfigPath) : undefined;
  for (const directory of ancestors(cwd, boundary)) {
    for (const name of [".miftahrc.json", "miftah.json"]) {
      const path = resolve(directory, name);
      if (path === runtimePath) continue;
      const file = await readKnownJson(path);
      if (!file.found) continue;
      const profile = strictMarkerProfile(file.value, wrapperName);
      if (profile === undefined) continue;
      assertKnownProfile(profile, knownProfileNames);
      return { profile, path };
    }
  }
  return undefined;
}

async function canonicalPath(path: string): Promise<string> {
  const resolvedPath = resolve(path);
  try {
    return await realpath(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

async function findPackageMetadata(
  cwd: string,
  boundary: string
): Promise<{ nearest?: PackageMetadata; workspace?: PackageMetadata }> {
  let nearest: PackageMetadata | undefined;
  let workspace: PackageMetadata | undefined;
  for (const directory of ancestors(cwd, boundary)) {
    const path = resolve(directory, "package.json");
    const file = await readKnownJson(path);
    if (!file.found) continue;
    const metadata = packageMetadata(file.value, path);
    if (!metadata) continue;
    nearest ??= metadata;
    if (metadata.workspace) workspace ??= metadata;
  }
  return { ...(nearest ? { nearest } : {}), ...(workspace ? { workspace } : {}) };
}

async function readKnownJson(path: string): Promise<KnownJsonFile> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return { found: false };
  }
  if (!stats.isFile() || stats.size > MAX_ROUTING_CONTEXT_JSON_BYTES) return { found: true };

  let file: FileHandle | undefined;
  try {
    file = await open(path, "r");
    const openedStats = await file.stat();
    // Do not read through a symlink swapped in after the path was inspected.
    if (
      !openedStats.isFile() ||
      openedStats.size > MAX_ROUTING_CONTEXT_JSON_BYTES ||
      openedStats.dev !== stats.dev ||
      openedStats.ino !== stats.ino
    ) {
      return { found: true };
    }
    const source = await file.readFile({ encoding: "utf8" });
    return { found: true, value: JSON.parse(source) as unknown };
  } catch {
    return { found: true };
  } finally {
    await file?.close();
  }
}

function strictMarkerProfile(value: unknown, wrapperName: string): string | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["profiles"]) || !isRecord(value.profiles)) return undefined;
  for (const profile of Object.values(value.profiles)) {
    if (typeof profile !== "string") return undefined;
  }
  const selected = value.profiles[wrapperName];
  return typeof selected === "string" ? selected : undefined;
}

function packageMetadata(value: unknown, path: string): PackageMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  const repositorySource = repositoryValue(value.repository);
  const repository = repositorySource === undefined ? undefined : redactUri(repositorySource);
  const githubRepository = repositorySource === undefined ? undefined : githubRepositoryFromSource(repositorySource);
  const workspace = isWorkspaceDeclaration(value.workspaces);
  if (name === undefined && repository === undefined && !workspace) return undefined;
  return {
    path,
    ...(name === undefined ? {} : { name }),
    ...(repository === undefined ? {} : { repository }),
    ...(githubRepository === undefined ? {} : { githubRepository }),
    workspace
  };
}

function repositoryValue(value: unknown): string | undefined {
  return (
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.url === "string"
        ? value.url
        : undefined
  );
}

function isWorkspaceDeclaration(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((entry) => typeof entry === "string");
  return (
    isRecord(value) &&
    Array.isArray(value.packages) &&
    value.packages.every((entry) => typeof entry === "string")
  );
}

function contextPackage(metadata: PackageMetadata): Record<string, string> {
  return {
    ...(metadata.name === undefined ? {} : { name: metadata.name }),
    ...(metadata.repository === undefined ? {} : { repository: metadata.repository })
  };
}

function evidencePackage(metadata: PackageMetadata): {
  path: string;
  name?: string;
  repository?: string;
} {
  return { path: metadata.path, ...contextPackage(metadata) };
}

async function findGitOrigin(
  cwd: string,
  boundary: string,
  executable: string
): Promise<GitOrigin | undefined> {
  try {
    const { stdout: gitDirectory } = await execFile(
      executable,
      ["rev-parse", "--git-common-dir"],
      gitExecutionOptions(cwd, boundary)
    );
    const resolvedGitDirectory = await realpath(resolve(cwd, gitDirectory.trim()));
    if (!isWithin(boundary, resolvedGitDirectory)) return undefined;

    const { stdout } = await execFile(
      executable,
      ["config", "--local", "--no-includes", "--get", "remote.origin.url"],
      gitExecutionOptions(cwd, boundary)
    );
    const origin = stdout.trim();
    if (origin.length === 0) return undefined;
    const githubRepository = githubRepositoryFromSource(origin);
    return {
      origin: redactUri(origin),
      ...(githubRepository === undefined ? {} : { githubRepository })
    };
  } catch {
    return undefined;
  }
}

function providerMatcherContext(
  packages: { nearest?: PackageMetadata; workspace?: PackageMetadata },
  gitOrigin: GitOrigin | undefined
): ProviderMatcherContext | undefined {
  const githubRepositories = [
    gitOrigin?.githubRepository,
    packages.nearest?.githubRepository,
    packages.workspace?.githubRepository
  ].filter((value): value is string => value !== undefined);
  const unique = [...new Set(githubRepositories)].sort();
  return unique.length === 0 ? undefined : { githubRepositories: unique };
}

function gitExecutionOptions(cwd: string, boundary: string): {
  cwd: string;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
} {
  return {
    cwd,
    maxBuffer: MAX_ROUTING_CONTEXT_JSON_BYTES,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_CEILING_DIRECTORIES: dirname(boundary)
    }
  };
}

function assertKnownProfile(profile: string, profiles: readonly string[]): void {
  if (!profiles.includes(profile)) {
    throw new MiftahError(
      "ROUTING_PROFILE_NOT_FOUND",
      "ROUTING_PROFILE_NOT_FOUND: routing context hint is not a configured profile"
    );
  }
}

function* ancestors(cwd: string, boundary: string): Generator<string> {
  let current = cwd;
  while (isWithin(boundary, current)) {
    yield current;
    if (current === boundary) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function isWithin(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !value.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
