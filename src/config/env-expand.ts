import { MiftahError } from "../utils/errors.js";

const environmentReference = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Expands references and returns the values sourced from the environment for diagnostic redaction. */
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

/** Expands environment references while retaining the established value-only public result. */
export function expandEnvironmentReferences(
  values: Record<string, string>,
  environment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return expandEnvironmentReferencesWithSecretValues(values, environment).values;
}
