import { parse } from "dotenv";
import { readFile as readFileAsync } from "node:fs/promises";
import { MiftahError } from "../utils/errors.js";

const exactEnvironmentReferencePattern = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const embeddedEnvironmentReferencePattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface SecretResolverOptions {
  environment?: NodeJS.ProcessEnv;
  envFiles?: string[];
  allowPlaintextSecrets?: boolean;
}

/** Contains resolved configuration values and every value sourced from a secret reference. */
export interface ResolvedSecretMap {
  values: Record<string, string>;
  secretValues: string[];
}

/** Resolves configured secret references without retaining provider-specific configuration in runtime objects. */
export class SecretResolver {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly values: Record<string, string>;
  private readonly options: SecretResolverOptions;

  constructor(options: SecretResolverOptions = {}) {
    this.options = options;
    this.environment = options.environment ?? process.env;
    this.values = Object.fromEntries(
      Object.entries(this.environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
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

  resolveMap(values: Record<string, string>): Record<string, string> {
    return this.resolveMapWithSecretValues(values).values;
  }

  /** Resolves a map while retaining secret-reference values for downstream diagnostic redaction. */
  resolveMapWithSecretValues(values: Record<string, string>): ResolvedSecretMap {
    const secretValues = new Set<string>();
    const resolvedValues = Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        const resolved = this.resolveValueWithSecretValues(value);
        for (const secretValue of resolved.secretValues) secretValues.add(secretValue);
        return [key, resolved.value];
      })
    );
    return { values: resolvedValues, secretValues: [...secretValues] };
  }

  resolveValue(value: string): string {
    return this.resolveValueWithSecretValues(value).value;
  }

  private resolveValueWithSecretValues(value: string): { value: string; secretValues: string[] } {
    const secretValues = new Set<string>();
    const resolveReference = (name: string): string => {
      const resolved = this.require(name);
      secretValues.add(resolved);
      return resolved;
    };
    const environmentReference = value.match(exactEnvironmentReferencePattern);
    if (environmentReference) {
      return { value: resolveReference(environmentReference[1]!), secretValues: [...secretValues] };
    }
    if (value.startsWith("secretref:env://")) {
      return { value: resolveReference(value.slice("secretref:env://".length)), secretValues: [...secretValues] };
    }
    if (value.startsWith("secretref:dotenv://")) {
      return { value: resolveReference(value.slice("secretref:dotenv://".length)), secretValues: [...secretValues] };
    }
    if (value.startsWith("secretref:plain://")) {
      if (this.options.allowPlaintextSecrets !== true) {
        throw new MiftahError(
          "SECRET_PROVIDER_FAILED",
          "SECRET_PROVIDER_FAILED: PLAINTEXT secret references are disabled"
        );
      }
      const resolved = value.slice("secretref:plain://".length);
      secretValues.add(resolved);
      return { value: resolved, secretValues: [...secretValues] };
    }
    if (value.startsWith("secretref:")) {
      throw new MiftahError(
        "SECRET_PROVIDER_FAILED",
        `SECRET_PROVIDER_FAILED: unsupported secret provider in '${value.slice(0, value.indexOf("://") + 3)}'`
      );
    }
    return {
      value: value.replace(embeddedEnvironmentReferencePattern, (_, name: string) => resolveReference(name)),
      secretValues: [...secretValues]
    };
  }

  private require(name: string): string {
    const value = this.values[name];
    if (value === undefined) {
      throw new MiftahError("SECRET_ENV_MISSING", `SECRET_ENV_MISSING: secret '${name}' is not defined`);
    }
    return value;
  }
}

export async function loadEnvFile(path: string): Promise<Record<string, string>> {
  return parse(await readFileAsync(path, "utf8"));
}
