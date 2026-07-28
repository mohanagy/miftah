import type { KeychainSecretReference, OnePasswordSecretReference } from "./external-secret-reference.js";

export type SecretProviderName = "env" | "dotenv" | "plain" | "keychain" | "op";

/** Safe provider metadata that may be included in diagnostics. */
export interface SecretReferenceDescriptor {
  readonly provider: SecretProviderName;
  readonly canonicalReference: string;
  readonly name?: string;
}

export interface EnvironmentSecretReference extends SecretReferenceDescriptor {
  readonly provider: "env";
  readonly name: string;
}

export interface DotenvSecretReference extends SecretReferenceDescriptor {
  readonly provider: "dotenv";
  readonly name: string;
}

export interface PlaintextSecretReference extends SecretReferenceDescriptor {
  readonly provider: "plain";
  readonly plaintext: string;
}

export type SecretProviderReference =
  | EnvironmentSecretReference
  | DotenvSecretReference
  | PlaintextSecretReference
  | KeychainSecretReference
  | OnePasswordSecretReference;

/** Resolve-only context. Providers receive resolved values only while resolving a reference. */
export interface SecretProviderResolveContext {
  readonly values: Readonly<Record<string, string>>;
  readonly allowPlaintextSecrets: boolean;
  /** Cancels the current bounded resolution without exposing provider output. */
  readonly signal?: AbortSignal;
  /** Registers a provider credential before it can be sent to a child process. */
  readonly registerSecret: (value: string) => void;
}

/** Availability-only context that intentionally excludes resolved secret values. */
export interface SecretProviderDiagnosticContext {
  readonly reference: SecretReferenceDescriptor;
  readonly availableNames: ReadonlySet<string>;
  readonly allowPlaintextSecrets: boolean;
}

export interface SecretProviderDiagnostic {
  readonly reference: SecretReferenceDescriptor;
  readonly available: boolean;
}

/** A successfully resolved secret that the resolver can register with its shared redactor. */
export interface SecretProviderResult {
  readonly value: string;
}

/** Resolver-owned registration that is called only after a provider resolves successfully. */
export type SecretRedactionRegistrar = (result: SecretProviderResult) => void;

/** Internal provider contract. It is deliberately not re-exported from the package root. */
export interface SecretProvider<Reference extends SecretProviderReference> {
  parse(value: string): Reference | undefined;
  resolve(reference: Reference, context: SecretProviderResolveContext): Promise<SecretProviderResult>;
  diagnose(context: SecretProviderDiagnosticContext): Promise<SecretProviderDiagnostic>;
}
