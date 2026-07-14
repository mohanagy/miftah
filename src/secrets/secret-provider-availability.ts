import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { win32 } from "node:path";
import type { MiftahConfig } from "../config/types.js";
import { resolveExecutablePath } from "./executable-resolver.js";

export type ExternalSecretProviderName = "keychain" | "op";
const externalSecretProviderNames = ["keychain", "op"] as const;

export interface SecretProviderAvailability {
  readonly provider: ExternalSecretProviderName;
  readonly available: boolean;
}

export interface SecretProviderAvailabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
}

/** Scans known secret-bearing maps without parsing or retaining reference payloads. */
export function scanConfiguredExternalSecretProviders(config: MiftahConfig): ExternalSecretProviderName[] {
  const providers = new Set<ExternalSecretProviderName>();
  const scanMap = (values: Record<string, string> | undefined): void => {
    for (const value of Object.values(values ?? {})) {
      if (value.startsWith("secretref:keychain:")) providers.add("keychain");
      if (value.startsWith("secretref:op:")) providers.add("op");
    }
  };
  const scanUpstream = (upstream: { env?: Record<string, string>; headers?: Record<string, string> }): void => {
    scanMap(upstream.env);
    scanMap(upstream.headers);
  };
  const scanProfile = (profile: MiftahConfig["profiles"][string]): void => {
    scanMap(profile.env);
    scanMap(profile.headers);
    for (const override of Object.values(profile.upstreams ?? {})) scanUpstream(override);
  };

  if (config.upstream) scanUpstream(config.upstream);
  for (const upstream of Object.values(config.upstreams ?? {})) scanUpstream(upstream);
  for (const profile of Object.values(config.profiles)) scanProfile(profile);
  if (config.server?.http?.authToken !== undefined) scanMap({ authToken: config.server.http.authToken });
  return externalSecretProviderNames.filter((provider) => providers.has(provider));
}

/** Checks executable/platform availability only; it never resolves a secret reference. */
export async function diagnoseConfiguredSecretProviders(
  providers: readonly ExternalSecretProviderName[],
  options: SecretProviderAvailabilityOptions = {}
): Promise<SecretProviderAvailability[]> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  return Promise.all(
    [...new Set(providers)]
      .sort()
      .map(async (provider) => ({
        provider,
        available: await isProviderAvailable(provider, platform, environment)
      }))
  );
}

async function isProviderAvailable(
  provider: ExternalSecretProviderName,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): Promise<boolean> {
  if (provider === "op") {
    return (await resolveExecutablePath("op", { platform, environment })) !== undefined;
  }
  if (platform === "darwin") return isExecutable("/usr/bin/security");
  if (platform === "linux") {
    return (await resolveExecutablePath("secret-tool", { platform, environment })) !== undefined;
  }
  if (platform === "win32") return isExecutable(windowsPowerShellPath(environment));
  return false;
}

async function isExecutable(path: string | undefined): Promise<boolean> {
  if (path === undefined) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsPowerShellPath(environment: NodeJS.ProcessEnv): string | undefined {
  const systemRoot = environmentValue(environment, "SystemRoot") ?? environmentValue(environment, "windir") ?? "C:\\Windows";
  if (!win32.isAbsolute(systemRoot)) return undefined;
  return win32.join(win32.resolve(systemRoot), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toLocaleLowerCase("en-US");
  for (const [candidateName, value] of Object.entries(environment)) {
    if (candidateName.toLocaleLowerCase("en-US") === normalizedName && value !== undefined) return value;
  }
  return undefined;
}
