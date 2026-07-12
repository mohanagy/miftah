import { MiftahError, type MiftahErrorCode } from "../utils/errors.js";
import {
  parseExternalSecretReference,
  type KeychainSecretReference,
  type OnePasswordSecretReference
} from "./external-secret-reference.js";
import {
  runSecretCommand,
  SecretProcessError,
  type SecretCommandOptions
} from "./secret-process-runner.js";
import type { SecretProvider } from "./secret-provider.js";

const defaultTimeoutMs = 10_000;
const windowsCredentialScript = `$signature = @'
using System;
using System.Runtime.InteropServices;
public static class MiftahCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NativeCredential {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string TargetName, UInt32 Type, UInt32 Flags, out IntPtr CredentialPtr);
  [DllImport("Advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr Buffer);
}
'@
Add-Type -TypeDefinition $signature
$target = 'miftah:keychain:' + $env:MIFTAH_KEYCHAIN_SERVICE + ':' + $env:MIFTAH_KEYCHAIN_ACCOUNT
[IntPtr]$credentialPointer = [IntPtr]::Zero
if (-not [MiftahCredential]::CredReadW($target, 1, 0, [ref]$credentialPointer)) { exit 1 }
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPointer, [type][MiftahCredential+NativeCredential])
  if ($credential.CredentialBlobSize -eq 0) { exit 1 }
  $value = [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, [int]($credential.CredentialBlobSize / 2))
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($value)
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
} finally {
  [MiftahCredential]::CredFree($credentialPointer)
}`;

type KeychainPlatform = "darwin" | "linux" | "win32";

export interface SecretCommandDescriptor {
  readonly executable: string;
  readonly prefixArgs?: readonly string[];
}

export interface KeychainSecretProviderOptions extends SecretCommandOptions {
  readonly platform?: NodeJS.Platform;
  readonly commands?: Partial<Record<KeychainPlatform, SecretCommandDescriptor>>;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface OnePasswordSecretProviderOptions extends SecretCommandOptions {
  readonly command?: SecretCommandDescriptor;
  readonly environment?: NodeJS.ProcessEnv;
  readonly isInteractive?: boolean;
}

/** Creates the platform-specific keychain provider without exposing process output. */
export function createKeychainSecretProvider(
  options: KeychainSecretProviderOptions = {}
): SecretProvider<KeychainSecretReference> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  return {
    parse(value) {
      if (!value.startsWith("secretref:keychain:")) return undefined;
      const reference = parseExternalSecretReference(value);
      return reference?.provider === "keychain" ? reference : undefined;
    },
    async resolve(reference) {
      if (!isKeychainPlatform(platform)) {
        throw providerError(
          "SECRET_PROVIDER_UNAVAILABLE",
          "keychain",
          reference.canonicalReference,
          "is unavailable on this platform"
        );
      }
      const descriptor = options.commands?.[platform] ?? defaultKeychainCommand(platform);
      try {
        const result = await runSecretCommand(
          {
            executable: descriptor.executable,
            args: keychainArguments(platform, descriptor.prefixArgs ?? [], reference),
            environment: keychainEnvironment(environment, platform, reference)
          },
          commandOptions(options)
        );
        const value = removeOneTerminalLineEnding(decodeOutput(result.stdout, "keychain", reference.canonicalReference));
        if (value.length === 0) {
          throw providerError("SECRET_ITEM_MISSING", "keychain", reference.canonicalReference, "returned no secret");
        }
        return { value };
      } catch (error) {
        throw normalizeProcessError(error, "keychain", reference.canonicalReference);
      }
    },
    async diagnose(context) {
      return { reference: context.reference, available: context.reference.provider === "keychain" && isKeychainPlatform(platform) };
    }
  };
}

/** Creates the `op read` provider with noninteractive service-account protection. */
export function createOnePasswordSecretProvider(
  options: OnePasswordSecretProviderOptions = {}
): SecretProvider<OnePasswordSecretReference> {
  const environment = options.environment ?? process.env;
  return {
    parse(value) {
      if (!value.startsWith("secretref:op:")) return undefined;
      const reference = parseExternalSecretReference(value);
      return reference?.provider === "op" ? reference : undefined;
    },
    async resolve(reference, context) {
      const interactive = options.isInteractive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
      const token = environment.OP_SERVICE_ACCOUNT_TOKEN;
      if (!interactive) {
        if (token === undefined || token.length === 0) {
          throw providerError(
            "SECRET_PROVIDER_NONINTERACTIVE",
            "op",
            reference.canonicalReference,
            "requires OP_SERVICE_ACCOUNT_TOKEN in a noninteractive process"
          );
        }
        context.registerSecret(token);
      }
      const descriptor = options.command ?? { executable: "op" };
      try {
        const result = await runSecretCommand(
          {
            executable: descriptor.executable,
            args: [...(descriptor.prefixArgs ?? []), "read", "--no-newline", reference.canonicalReference.slice("secretref:".length)],
            environment: childEnvironment(environment)
          },
          commandOptions(options)
        );
        const value = decodeOutput(result.stdout, "op", reference.canonicalReference);
        if (value.length === 0) {
          throw providerError("SECRET_ITEM_MISSING", "op", reference.canonicalReference, "returned no secret");
        }
        return { value };
      } catch (error) {
        throw normalizeProcessError(error, "op", reference.canonicalReference);
      }
    },
    async diagnose(context) {
      return { reference: context.reference, available: context.reference.provider === "op" };
    }
  };
}

function isKeychainPlatform(platform: NodeJS.Platform): platform is KeychainPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

function defaultKeychainCommand(platform: KeychainPlatform): SecretCommandDescriptor {
  if (platform === "darwin") return { executable: "/usr/bin/security" };
  if (platform === "linux") return { executable: "secret-tool" };
  return { executable: "powershell.exe" };
}

function keychainArguments(
  platform: KeychainPlatform,
  prefixArgs: readonly string[],
  reference: KeychainSecretReference
): string[] {
  if (platform === "darwin") {
    return [...prefixArgs, "find-generic-password", "-s", reference.service, "-a", reference.account, "-w"];
  }
  if (platform === "linux") {
    return [...prefixArgs, "lookup", "service", reference.service, "account", reference.account];
  }
  return [
    ...prefixArgs,
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(windowsCredentialScript, "utf16le").toString("base64")
  ];
}

function keychainEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: KeychainPlatform,
  reference: KeychainSecretReference
): NodeJS.ProcessEnv {
  if (platform !== "win32") return childEnvironment(environment, undefined, ["OP_SERVICE_ACCOUNT_TOKEN"]);
  return childEnvironment(
    environment,
    {
      MIFTAH_KEYCHAIN_SERVICE: encodeURIComponent(reference.service),
      MIFTAH_KEYCHAIN_ACCOUNT: encodeURIComponent(reference.account)
    },
    ["OP_SERVICE_ACCOUNT_TOKEN"]
  );
}

function childEnvironment(
  environment: NodeJS.ProcessEnv,
  additions: NodeJS.ProcessEnv = {},
  omittedNames: readonly string[] = []
): NodeJS.ProcessEnv {
  const omitted = new Set(omittedNames);
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && !omitted.has(name)) child[name] = value;
  }
  for (const [name, value] of Object.entries(additions)) {
    if (value !== undefined) child[name] = value;
  }
  return child;
}

function commandOptions(options: SecretCommandOptions): SecretCommandOptions {
  return { timeoutMs: options.timeoutMs ?? defaultTimeoutMs, signal: options.signal };
}

function removeOneTerminalLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function decodeOutput(stdout: Buffer, provider: "keychain" | "op", reference: string): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    throw providerError("SECRET_PROVIDER_FAILED", provider, reference, "returned invalid output");
  }
  if (value.includes("\u0000")) {
    throw providerError("SECRET_PROVIDER_FAILED", provider, reference, "returned invalid output");
  }
  return value;
}

function normalizeProcessError(error: unknown, provider: "keychain" | "op", reference: string): MiftahError {
  if (error instanceof MiftahError) return error;
  if (!(error instanceof SecretProcessError)) {
    return providerError("SECRET_PROVIDER_FAILED", provider, reference, "failed");
  }
  if (error.kind === "unavailable") {
    return providerError("SECRET_PROVIDER_UNAVAILABLE", provider, reference, "is unavailable");
  }
  if (error.kind === "timeout") {
    return providerError("SECRET_PROVIDER_TIMEOUT", provider, reference, "timed out");
  }
  if (error.kind === "cancelled") {
    return providerError("SECRET_PROVIDER_CANCELLED", provider, reference, "was cancelled");
  }
  if (error.kind === "exit" && error.classification === "locked") {
    return providerError("SECRET_PROVIDER_LOCKED", provider, reference, "is locked or authentication failed");
  }
  if (error.kind === "exit" && error.classification === "noninteractive") {
    return providerError("SECRET_PROVIDER_NONINTERACTIVE", provider, reference, "requires interactive authentication");
  }
  if (error.kind === "exit" && error.classification === "missing") {
    return providerError("SECRET_ITEM_MISSING", provider, reference, "could not find the requested secret");
  }
  return providerError("SECRET_PROVIDER_FAILED", provider, reference, "failed");
}

function providerError(
  code: MiftahErrorCode,
  provider: "keychain" | "op",
  reference: string,
  reason: string
): MiftahError {
  return new MiftahError(code, `${code}: ${provider} provider ${reason} for '${reference}'`, {
    provider,
    reference
  });
}
