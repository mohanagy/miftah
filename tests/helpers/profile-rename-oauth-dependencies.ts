import {
  OAuthConnectionRegistry,
  type OAuthConnectionMetadataStore,
  type OAuthConnectionRecord
} from "../../src/oauth/connection-registry.js";
import type { OAuthProfileRenameDependencies } from "../../src/oauth/profile-rename-transaction.js";
import type { OAuthConnectionBinding } from "../../src/oauth/connection-types.js";
import type { OAuthCredential, OAuthCredentialStore } from "../../src/oauth/secure-credential-store.js";

export class MemoryProfileRenameCredentialStore implements OAuthCredentialStore {
  readonly entries = new Map<string, OAuthCredential>();
  deleteFailure?: (binding: OAuthConnectionBinding) => Error | undefined;

  async load(binding: OAuthConnectionBinding): Promise<OAuthCredential | undefined> {
    const credential = this.entries.get(JSON.stringify(binding));
    return credential === undefined ? undefined : structuredClone(credential);
  }

  async save(binding: OAuthConnectionBinding, credential: OAuthCredential): Promise<void> {
    this.entries.set(JSON.stringify(binding), structuredClone(credential));
  }

  async delete(binding: OAuthConnectionBinding): Promise<void> {
    const failure = this.deleteFailure?.(binding);
    if (failure !== undefined) throw failure;
    this.entries.delete(JSON.stringify(binding));
  }
}

export class MemoryProfileRenameMetadataStore implements OAuthConnectionMetadataStore {
  records: readonly OAuthConnectionRecord[] = [];

  async load(): Promise<readonly OAuthConnectionRecord[]> {
    return structuredClone(this.records);
  }

  async save(records: readonly OAuthConnectionRecord[]): Promise<void> {
    this.records = structuredClone(records);
  }
}

/** Hermetic test dependencies; production Console construction always uses OS-backed defaults. */
export function createMemoryProfileRenameOAuthDependencies(): {
  readonly credentials: MemoryProfileRenameCredentialStore;
  readonly registry: OAuthConnectionRegistry;
  readonly dependencies: OAuthProfileRenameDependencies;
} {
  const credentials = new MemoryProfileRenameCredentialStore();
  const registry = new OAuthConnectionRegistry(new MemoryProfileRenameMetadataStore(), () => "2030-01-02T03:04:05.000Z");
  return {
    credentials,
    registry,
    dependencies: { credentialStore: credentials, registry }
  };
}
