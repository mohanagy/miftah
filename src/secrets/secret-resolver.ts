import { parse } from "dotenv";
import { readFile as readFileAsync } from "node:fs/promises";
import { MiftahError } from "../utils/errors.js";
import { createBuiltinSecretProviders } from "./builtin-secret-providers.js";
import { SecretRedactor } from "./redact.js";
import type {
  SecretProvider,
  SecretProviderReference,
  SecretRedactionRegistrar
} from "./secret-provider.js";
import type { BuiltinSecretProviders } from "./builtin-secret-providers.js";

const embeddedEnvironmentReferencePattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface SecretResolverOptions {
  environment?: NodeJS.ProcessEnv;
  envFiles?: string[];
  allowPlaintextSecrets?: boolean;
  providerTimeoutMs?: number;
  redactor?: SecretRedactor;
  /** Internal injection point for provider integration tests and runtime composition. */
  providers?: Partial<BuiltinSecretProviders>;
}

/** Contains resolved configuration values and every value sourced from a secret reference. */
export interface ResolvedSecretMap {
  values: Record<string, string>;
  secretValues: string[];
}

/** Contains one resolved configuration value and every secret value it sourced. */
export interface ResolvedSecretValue {
  value: string;
  secretValues: string[];
}

/** Resolves configured secret references without retaining provider-specific configuration in runtime objects. */
export class SecretResolver {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly values: Record<string, string>;
  private readonly options: SecretResolverOptions;
  private readonly redactor: SecretRedactor;
  private readonly providers: BuiltinSecretProviders;
  private readonly resolutionCache = new Map<string, Promise<string>>();

  constructor(options: SecretResolverOptions = {}) {
    this.options = options;
    this.environment = options.environment ?? process.env;
    this.values = Object.fromEntries(
      Object.entries(this.environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    this.redactor = options.redactor ?? new SecretRedactor();
    this.providers = {
      ...createBuiltinSecretProviders({ providerTimeoutMs: options.providerTimeoutMs }),
      ...options.providers
    };
  }

  async load(): Promise<void> {
    for (const path of this.options.envFiles ?? []) {
      let content: string;
      try {
        content = await readFileAsync(path, "utf8");
      } catch (error) {
        throw new MiftahError("SECRET_PROVIDER_FAILED", `SECRET_PROVIDER_FAILED: unable to read env file '${path}'`, {
          cause: error instanceof Error ? error.message : String(error)
        });
      }
      for (const [key, value] of Object.entries(parse(content))) {
        if (this.values[key] === undefined) this.values[key] = value;
      }
    }
  }

  async resolveMap(values: Record<string, string>): Promise<Record<string, string>> {
    return (await this.resolveMapWithSecretValues(values)).values;
  }

  /** Resolves a map while retaining secret-reference values for downstream diagnostic redaction. */
  async resolveMapWithSecretValues(values: Record<string, string>): Promise<ResolvedSecretMap> {
    const secretValues = new Set<string>();
    const resolvedValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      const resolved = await this.resolveValueWithSecretValues(value);
      for (const secretValue of resolved.secretValues) secretValues.add(secretValue);
      resolvedValues[key] = resolved.value;
    }
    return { values: resolvedValues, secretValues: [...secretValues] };
  }

  async resolveValue(value: string): Promise<string> {
    return (await this.resolveValueWithSecretValues(value)).value;
  }

  /** Resolves one value while retaining sourced secrets for downstream redaction. */
  async resolveValueWithSecretValues(value: string): Promise<ResolvedSecretValue> {
    const secretValues = new Set<string>();
    const environmentReference = this.providers.environment.parse(value);
    if (environmentReference) {
      const resolved = await this.resolveReference(this.providers.environment, environmentReference, secretValues);
      return { value: resolved, secretValues: [...secretValues] };
    }
    const dotenvReference = this.providers.dotenv.parse(value);
    if (dotenvReference) {
      const resolved = await this.resolveReference(this.providers.dotenv, dotenvReference, secretValues);
      return { value: resolved, secretValues: [...secretValues] };
    }
    const plaintextReference = this.providers.plaintext.parse(value);
    if (plaintextReference) {
      const resolved = await this.resolveReference(this.providers.plaintext, plaintextReference, secretValues);
      return { value: resolved, secretValues: [...secretValues] };
    }
    const keychainReference = this.providers.keychain.parse(value);
    if (keychainReference) {
      const resolved = await this.resolveReference(this.providers.keychain, keychainReference, secretValues);
      return { value: resolved, secretValues: [...secretValues] };
    }
    const onePasswordReference = this.providers.op.parse(value);
    if (onePasswordReference) {
      const resolved = await this.resolveReference(this.providers.op, onePasswordReference, secretValues);
      return { value: resolved, secretValues: [...secretValues] };
    }
    if (value.startsWith("secretref:")) {
      throw new MiftahError(
        "SECRET_PROVIDER_FAILED",
        `SECRET_PROVIDER_FAILED: unsupported secret provider in '${unsupportedProviderReference(value)}'`
      );
    }
    return { value: await this.resolveEmbeddedEnvironmentReferences(value, secretValues), secretValues: [...secretValues] };
  }

  private async resolveEmbeddedEnvironmentReferences(value: string, secretValues: Set<string>): Promise<string> {
    let resolvedValue = "";
    let offset = 0;
    for (const match of value.matchAll(embeddedEnvironmentReferencePattern)) {
      const placeholder = match[0];
      const index = match.index;
      if (placeholder === undefined || index === undefined) continue;
      resolvedValue += value.slice(offset, index);
      const reference = this.providers.environment.parse(placeholder);
      if (reference === undefined) {
        throw new MiftahError("SECRET_PROVIDER_FAILED", "SECRET_PROVIDER_FAILED: invalid environment secret reference");
      }
      resolvedValue += await this.resolveReference(this.providers.environment, reference, secretValues);
      offset = index + placeholder.length;
    }
    return resolvedValue + value.slice(offset);
  }

  private async resolveReference<Reference extends SecretProviderReference>(
    provider: SecretProvider<Reference>,
    reference: Reference,
    secretValues: Set<string>
  ): Promise<string> {
    // Plaintext references deliberately share a redacted canonical diagnostic value, so caching them would alias secrets.
    const cacheKey = reference.provider === "plain" ? undefined : `${reference.provider}:${reference.canonicalReference}`;
    let resolution = cacheKey === undefined ? undefined : this.resolutionCache.get(cacheKey);
    if (resolution === undefined) {
      resolution = provider
        .resolve(reference, {
          values: this.values,
          allowPlaintextSecrets: this.options.allowPlaintextSecrets === true,
          registerSecret: (value) => this.redactor.add(value)
        })
        .then((result) => {
          this.redactor.add(result.value);
          return result.value;
        });
      if (cacheKey !== undefined) {
        this.resolutionCache.set(cacheKey, resolution);
        void resolution.catch(() => {
          if (this.resolutionCache.get(cacheKey) === resolution) this.resolutionCache.delete(cacheKey);
        });
      }
    }
    const resolved = await resolution;
    const registerResolvedSecret: SecretRedactionRegistrar = (result) => {
      this.redactor.add(result.value);
      secretValues.add(result.value);
    };
    registerResolvedSecret({ value: resolved });
    return resolved;
  }
}

export async function loadEnvFile(path: string): Promise<Record<string, string>> {
  return parse(await readFileAsync(path, "utf8"));
}

function unsupportedProviderReference(value: string): string {
  const schemeEnd = value.indexOf("://");
  return schemeEnd >= 0 ? value.slice(0, schemeEnd + 3) : "secretref:";
}
