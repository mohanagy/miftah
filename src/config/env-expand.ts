import { MiftahError } from "../utils/errors.js";

const environmentReference = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Expands environment variable references in configuration values and collects their resolved values.
 *
 * @param values - Configuration values that may contain `${NAME}` references
 * @param environment - Environment variables used to resolve references
 * @returns The expanded values and the unique resolved environment values
 * @throws `MiftahError` if a referenced environment variable is undefined
 */
export function expandEnvironmentReferencesWithSecretValues(
  values: Record<string, string>,
  environment: NodeJS.ProcessEnv = process.env
): { values: Record<string, string>; secretValues: string[] } {
  const secretValues = new Set<string>();
  const expandedValues = Object.fromEntries(
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
        secretValues.add(resolved);
        return resolved;
      })
    ])
  );
  return { values: expandedValues, secretValues: [...secretValues] };
}

/**
 * Expands environment variable references in string values.
 *
 * @param values - Key-value pairs whose values may contain `${NAME}` references.
 * @param environment - Environment variables used to resolve references.
 * @returns The values with environment variable references replaced by their resolved values.
 */
export function expandEnvironmentReferences(
  values: Record<string, string>,
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return expandEnvironmentReferencesWithSecretValues(values, environment).values;
}
