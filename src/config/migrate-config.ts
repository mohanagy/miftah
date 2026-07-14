import { MiftahError } from "../utils/errors.js";
import { validateConfig } from "./validate-config.js";
import { CURRENT_CONFIG_VERSION } from "./versions.js";

export interface ConfigMigrationPlan {
  readonly fromVersion: string;
  readonly toVersion: typeof CURRENT_CONFIG_VERSION;
  readonly changed: boolean;
  readonly actions: readonly string[];
  /** Internal validated JSON ready for an explicit same-directory non-overwriting publication. */
  readonly config: unknown;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]));
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function movePlaintextSecretOptIn(config: JsonRecord, actions: string[]): void {
  const security = asRecord(config.security);
  if (security?.allowPlaintextSecrets === undefined) return;

  const existingSecrets = config.secrets;
  if (existingSecrets !== undefined && !isRecord(existingSecrets)) {
    throw new MiftahError(
      "CONFIG_MIGRATION_CONFLICT",
      "CONFIG_MIGRATION_CONFLICT: secrets must be an object before migrating security.allowPlaintextSecrets"
    );
  }
  const secrets = existingSecrets === undefined ? {} : existingSecrets;
  const legacyValue = security.allowPlaintextSecrets;
  if (secrets.allowPlaintextSecrets !== undefined && secrets.allowPlaintextSecrets !== legacyValue) {
    throw new MiftahError(
      "CONFIG_MIGRATION_CONFLICT",
      "CONFIG_MIGRATION_CONFLICT: security.allowPlaintextSecrets and secrets.allowPlaintextSecrets disagree"
    );
  }
  secrets.allowPlaintextSecrets = legacyValue;
  config.secrets = secrets;
  delete security.allowPlaintextSecrets;
  if (Object.keys(security).length === 0) delete config.security;
  actions.push("Moved the plaintext-secret opt-in to secrets.allowPlaintextSecrets.");
}

function removeForceOnRedactionDeclarations(config: JsonRecord, actions: string[]): void {
  const security = asRecord(config.security);
  if (security?.redactSecrets === true) {
    delete security.redactSecrets;
    if (Object.keys(security).length === 0) delete config.security;
    actions.push("Removed the redundant secret-redaction declaration.");
  }

  const audit = asRecord(config.audit);
  if (audit?.redact === true) {
    delete audit.redact;
    if (Object.keys(audit).length === 0) delete config.audit;
    actions.push("Removed the redundant audit-redaction declaration.");
  }
}

function migrateTransportAlias(value: unknown, path: string, actions: string[]): void {
  const upstream = asRecord(value);
  if (upstream?.transport !== "http") return;
  upstream.transport = "streamable-http";
  actions.push(`Replaced the ${path} http transport alias with streamable-http.`);
}

function migrateV1(config: JsonRecord): ConfigMigrationPlan {
  const actions: string[] = [];
  migrateTransportAlias(config.upstream, "upstream", actions);
  const upstreams = asRecord(config.upstreams);
  for (const name of Object.keys(upstreams ?? {}).sort()) {
    migrateTransportAlias(upstreams?.[name], `upstreams.${name}`, actions);
  }
  movePlaintextSecretOptIn(config, actions);
  removeForceOnRedactionDeclarations(config, actions);
  config.version = CURRENT_CONFIG_VERSION;
  actions.unshift(`Updated config version from 1 to ${CURRENT_CONFIG_VERSION}.`);
  validateConfig(config);
  return {
    fromVersion: "1",
    toVersion: CURRENT_CONFIG_VERSION,
    changed: true,
    actions,
    config
  };
}

/** Plans a migration without reading or writing files; callers must opt in to applying its validated output. */
export function planConfigMigration(input: unknown): ConfigMigrationPlan {
  if (!isRecord(input)) {
    throw new MiftahError("CONFIG_SCHEMA_INVALID", "CONFIG_SCHEMA_INVALID: config migration requires a JSON object");
  }
  const config = cloneJson(input);
  if (!isRecord(config)) {
    throw new MiftahError("CONFIG_SCHEMA_INVALID", "CONFIG_SCHEMA_INVALID: config migration requires a JSON object");
  }
  const version = config.version;
  if (version === CURRENT_CONFIG_VERSION) {
    validateConfig(config);
    return {
      fromVersion: CURRENT_CONFIG_VERSION,
      toVersion: CURRENT_CONFIG_VERSION,
      changed: false,
      actions: [],
      config
    };
  }
  if (version !== "1") {
    throw new MiftahError(
      "UNSUPPORTED_CONFIG_VERSION",
      "UNSUPPORTED_CONFIG_VERSION: migrate-config supports version 1 input and version 2 output only"
    );
  }
  return migrateV1(config);
}
