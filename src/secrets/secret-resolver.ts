import { parse } from "dotenv";
import { readFile as readFileAsync } from "node:fs/promises";
import { MiftahError } from "../utils/errors.js";

export interface SecretResolverOptions {
  environment?: NodeJS.ProcessEnv;
  envFiles?: string[];
  allowPlaintextSecrets?: boolean;
}

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
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, this.resolveValue(value)]));
  }

  resolveValue(value: string): string {
    const environmentReference = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (environmentReference) {
      return this.require(environmentReference[1]!);
    }
    if (value.startsWith("secretref:env://")) {
      return this.require(value.slice("secretref:env://".length));
    }
    if (value.startsWith("secretref:dotenv://")) {
      return this.require(value.slice("secretref:dotenv://".length));
    }
    if (value.startsWith("secretref:plain://")) {
      if (this.options.allowPlaintextSecrets !== true) {
        throw new MiftahError(
          "SECRET_PROVIDER_FAILED",
          "SECRET_PROVIDER_FAILED: PLAINTEXT secret references are disabled"
        );
      }
      return value.slice("secretref:plain://".length);
    }
    if (value.startsWith("secretref:")) {
      throw new MiftahError(
        "SECRET_PROVIDER_FAILED",
        `SECRET_PROVIDER_FAILED: unsupported secret provider in '${value.slice(0, value.indexOf("://") + 3)}'`
      );
    }
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => this.require(name));
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
