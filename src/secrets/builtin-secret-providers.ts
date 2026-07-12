import { MiftahError } from "../utils/errors.js";
import type {
  DotenvSecretReference,
  EnvironmentSecretReference,
  PlaintextSecretReference,
  SecretProvider,
  SecretProviderDiagnostic,
  SecretProviderDiagnosticContext,
  SecretProviderResult,
  SecretProviderResolveContext
} from "./secret-provider.js";

const environmentReferencePattern = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const environmentPrefix = "secretref:env://";
const dotenvPrefix = "secretref:dotenv://";
const plaintextPrefix = "secretref:plain://";
const redactedPlaintextReference = "secretref:plain://[REDACTED]";

function resolvedSecret(value: string): SecretProviderResult {
  return { value };
}

function missingEnvironmentSecret(name: string): never {
  throw new MiftahError("SECRET_ENV_MISSING", `SECRET_ENV_MISSING: secret '${name}' is not defined`);
}

class EnvironmentSecretProvider implements SecretProvider<EnvironmentSecretReference> {
  parse(value: string): EnvironmentSecretReference | undefined {
    const interpolation = value.match(environmentReferencePattern);
    const name = interpolation?.[1] ?? (value.startsWith(environmentPrefix) ? value.slice(environmentPrefix.length) : undefined);
    if (name === undefined) return undefined;
    return {
      provider: "env",
      canonicalReference: `${environmentPrefix}${name}`,
      name
    };
  }

  async resolve(
    reference: EnvironmentSecretReference,
    context: SecretProviderResolveContext
  ): Promise<SecretProviderResult> {
    const value = context.values[reference.name];
    if (value === undefined) missingEnvironmentSecret(reference.name);
    return resolvedSecret(value);
  }

  async diagnose(context: SecretProviderDiagnosticContext): Promise<SecretProviderDiagnostic> {
    return {
      reference: context.reference,
      available: context.reference.provider === "env" && context.availableNames.has(context.reference.name ?? "")
    };
  }
}

class DotenvSecretProvider implements SecretProvider<DotenvSecretReference> {
  parse(value: string): DotenvSecretReference | undefined {
    if (!value.startsWith(dotenvPrefix)) return undefined;
    const name = value.slice(dotenvPrefix.length);
    return {
      provider: "dotenv",
      canonicalReference: `${dotenvPrefix}${name}`,
      name
    };
  }

  async resolve(
    reference: DotenvSecretReference,
    context: SecretProviderResolveContext
  ): Promise<SecretProviderResult> {
    const value = context.values[reference.name];
    if (value === undefined) missingEnvironmentSecret(reference.name);
    return resolvedSecret(value);
  }

  async diagnose(context: SecretProviderDiagnosticContext): Promise<SecretProviderDiagnostic> {
    return {
      reference: context.reference,
      available: context.reference.provider === "dotenv" && context.availableNames.has(context.reference.name ?? "")
    };
  }
}

class PlaintextSecretProvider implements SecretProvider<PlaintextSecretReference> {
  parse(value: string): PlaintextSecretReference | undefined {
    if (!value.startsWith(plaintextPrefix)) return undefined;
    return {
      provider: "plain",
      canonicalReference: redactedPlaintextReference,
      plaintext: value.slice(plaintextPrefix.length)
    };
  }

  async resolve(
    reference: PlaintextSecretReference,
    context: SecretProviderResolveContext
  ): Promise<SecretProviderResult> {
    if (!context.allowPlaintextSecrets) {
      throw new MiftahError(
        "SECRET_PROVIDER_FAILED",
        `SECRET_PROVIDER_FAILED: PLAINTEXT secret reference '${reference.canonicalReference}' is disabled`
      );
    }
    return resolvedSecret(reference.plaintext);
  }

  async diagnose(context: SecretProviderDiagnosticContext): Promise<SecretProviderDiagnostic> {
    return {
      reference: context.reference,
      available: context.reference.provider === "plain" && context.allowPlaintextSecrets
    };
  }
}

export interface BuiltinSecretProviders {
  readonly environment: SecretProvider<EnvironmentSecretReference>;
  readonly dotenv: SecretProvider<DotenvSecretReference>;
  readonly plaintext: SecretProvider<PlaintextSecretReference>;
}

export function createBuiltinSecretProviders(): BuiltinSecretProviders {
  return {
    environment: new EnvironmentSecretProvider(),
    dotenv: new DotenvSecretProvider(),
    plaintext: new PlaintextSecretProvider()
  };
}
