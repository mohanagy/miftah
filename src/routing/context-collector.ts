import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { redactUri } from "../secrets/redact.js";
import { MiftahError } from "../utils/errors.js";
import type {
  RoutingContextCollectorInput,
  RoutingContextEvidence,
  RoutingContextMcpRoot,
  RoutingContextProfileHint,
  RoutingContextSnapshot
} from "./routing-types.js";

const execFile = promisify(execFileCallback);

/** Maximum bytes read from a known JSON metadata file before it is ignored. */
export const MAX_ROUTING_CONTEXT_JSON_BYTES = 64 * 1024;

interface ProjectMarker {
  readonly profile: string;
  readonly path: string;
}

interface PackageMetadata {
  readonly path: string;
  readonly name?: string;
  readonly repository?: string;
  readonly workspace: boolean;
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
  if (gitOrigin) context.git = { origin: gitOrigin };

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
    ...(gitOrigin ? { git: { origin: gitOrigin } } : {})
  };

  return deepFreeze({ context, evidence, profileHints: hints });
}

function collectEnvironment(environment: Readonly<Record<string, string | undefined>>): {
  profile?: string;
  project?: string;
} {
  return {
    ...(environment.MIFTAH_PROFILE === undefined ? {} : { profile: environment.MIFTAH_PROFILE }),
    ...(environment.MIFTAH_PROJECT === undefined ? {} : { project: environment.MIFTAH_PROJECT })
  };
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
  const runtimePath = runtimeConfigPath ? resolve(runtimeConfigPath) : undefined;
  for (const directory of ancestors(cwd, boundary)) {
    for (const name of [".miftahrc.json", "miftah.json"]) {
      const path = resolve(directory, name);
      if (path === runtimePath) continue;
      const file = await readKnownJson(path);
      if (!file.found) continue;
      const profile = strictMarkerProfile(file.value, wrapperName);
      if (profile === undefined) return undefined;
      assertKnownProfile(profile, knownProfileNames);
      return { profile, path };
    }
  }
  return undefined;
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
  try {
    const source = await readFile(path, "utf8");
    return { found: true, value: JSON.parse(source) as unknown };
  } catch {
    return { found: true };
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
  const repository = repositoryUri(value.repository);
  const workspace = isWorkspaceDeclaration(value.workspaces);
  if (name === undefined && repository === undefined && !workspace) return undefined;
  return {
    path,
    ...(name === undefined ? {} : { name }),
    ...(repository === undefined ? {} : { repository }),
    workspace
  };
}

function repositoryUri(value: unknown): string | undefined {
  const raw =
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.url === "string"
        ? value.url
        : undefined;
  return raw === undefined ? undefined : redactUri(raw);
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
): Promise<string | undefined> {
  try {
    const { stdout } = await execFile(executable, ["remote", "get-url", "origin"], {
      cwd,
      maxBuffer: MAX_ROUTING_CONTEXT_JSON_BYTES,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
        ),
        GIT_CEILING_DIRECTORIES: dirname(boundary)
      }
    });
    const origin = stdout.trim();
    return origin.length === 0 ? undefined : redactUri(origin);
  } catch {
    return undefined;
  }
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
