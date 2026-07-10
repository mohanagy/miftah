import { MiftahError } from "../utils/errors.js";

const environmentReference = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function expandEnvironmentReferences(
  values: Record<string, string>,
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replace(environmentReference, (_, name: string) => {
        const resolved = environment[name];
        if (resolved === undefined) {
          throw new MiftahError(
            "SECRET_ENV_MISSING",
            `SECRET_ENV_MISSING: profile environment variable '${name}' is not defined`
          );
        }
        return resolved;
      })
    ])
  );
}
