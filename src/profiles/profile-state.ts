import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type ProfileStateScope = "process" | "session" | "workspace" | "global";
export type ProfileStateDiagnostic = "PROFILE_STATE_INVALID" | "PROFILE_STATE_STALE" | "PROFILE_STATE_UNAVAILABLE";

export interface ProfileStateOptions {
  readonly persistActiveProfile?: boolean;
  readonly scope?: ProfileStateScope;
  readonly configPath: string;
  /** Internal test seam for the platform user-state directory. */
  readonly globalStateDirectory?: string;
}

interface StoredProfileState {
  readonly version: 1;
  readonly scope: "workspace" | "global";
  readonly configIdentity: string;
  readonly profile: string;
  readonly selectedAt: string;
}

export type ProfileStateLoadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly profile: string; readonly selectedAt: string }
  | { readonly kind: "invalid" | "unavailable" };

const durableScopes = new Set<ProfileStateScope>(["workspace", "global"]);

export function profileStateScope(options: ProfileStateOptions): ProfileStateScope {
  return options.scope ?? "process";
}

export function hasDurableProfileState(options: ProfileStateOptions): boolean {
  return options.persistActiveProfile === true && durableScopes.has(profileStateScope(options));
}

export function resolveProfileStatePath(options: ProfileStateOptions): string {
  const scope = profileStateScope(options);
  if (!hasDurableProfileState(options) || (scope !== "workspace" && scope !== "global")) {
    throw new Error("A durable profile state path requires workspace or global persistence.");
  }

  const identity = profileStateIdentity(options.configPath);
  if (scope === "workspace") {
    return join(dirname(resolve(options.configPath)), ".miftah", "state", `${identity}.json`);
  }
  return join(globalStateDirectory(options), "miftah", "state", `${identity}.json`);
}

/** Stores only the selected profile and its safe selection time. */
export class ProfileStateStore {
  readonly scope: ProfileStateScope;
  readonly persistent: boolean;
  private readonly path: string | undefined;
  private readonly identity: string;

  constructor(private readonly options: ProfileStateOptions) {
    this.scope = profileStateScope(options);
    this.persistent = hasDurableProfileState(options);
    this.path = this.persistent ? resolveProfileStatePath(options) : undefined;
    this.identity = profileStateIdentity(options.configPath);
  }

  async load(): Promise<ProfileStateLoadResult> {
    if (this.path === undefined || (this.scope !== "workspace" && this.scope !== "global")) {
      return { kind: "missing" };
    }

    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "unavailable" };
    }

    const record = parseStoredState(content);
    if (
      record === undefined ||
      record.scope !== this.scope ||
      record.configIdentity !== this.identity
    ) {
      return { kind: "invalid" };
    }
    return { kind: "valid", profile: record.profile, selectedAt: record.selectedAt };
  }

  async save(profile: string, selectedAt: string): Promise<void> {
    if (this.path === undefined || (this.scope !== "workspace" && this.scope !== "global")) return;

    const record: StoredProfileState = {
      version: 1,
      scope: this.scope,
      configIdentity: this.identity,
      profile,
      selectedAt
    };
    await writeAtomically(this.path, JSON.stringify(record));
  }
}

function profileStateIdentity(configPath: string): string {
  return createHash("sha256").update(resolve(configPath)).digest("hex");
}

function globalStateDirectory(options: ProfileStateOptions): string {
  if (options.globalStateDirectory !== undefined) return resolve(options.globalStateDirectory);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    return localAppData !== undefined && isAbsolute(localAppData)
      ? resolve(localAppData)
      : join(homedir(), "AppData", "Local");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  const xdgStateHome = process.env.XDG_STATE_HOME;
  return xdgStateHome !== undefined && isAbsolute(xdgStateHome)
    ? resolve(xdgStateHome)
    : join(homedir(), ".local", "state");
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await setRestrictiveMode(directory, 0o700);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await setRestrictiveMode(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Unable to atomically persist profile state", { cause: error });
    }
    throw error;
  }
}

async function setRestrictiveMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
  }
}

function parseStoredState(content: string): StoredProfileState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (
    value.version !== 1 ||
    (value.scope !== "workspace" && value.scope !== "global") ||
    typeof value.configIdentity !== "string" ||
    value.configIdentity.length === 0 ||
    typeof value.profile !== "string" ||
    value.profile.length === 0 ||
    typeof value.selectedAt !== "string" ||
    !Number.isFinite(Date.parse(value.selectedAt))
  ) {
    return undefined;
  }
  return {
    version: 1,
    scope: value.scope,
    configIdentity: value.configIdentity,
    profile: value.profile,
    selectedAt: value.selectedAt
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
