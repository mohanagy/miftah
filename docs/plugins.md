# Local plugin API

Miftah supports explicit, local ESM plugins for secret references and routing matchers. The stable authoring API is the versioned subpath `@lubab/miftah/plugin-api`; Miftah internals are not part of that contract.

```ts
import type { SecretProviderPlugin } from "@lubab/miftah/plugin-api";

const plugin: SecretProviderPlugin = {
  apiVersion: "1",
  id: "company-vault",
  kind: "secret-provider",
  async resolve({ reference }) {
    // Resolve exactly this canonical reference.
    return { value: "..." };
  }
};

export default plugin;
```

Configure only explicit local `.mjs` paths below the configuration directory. During preflight Miftah resolves the module and verifies that its real path remains below that directory, so a symlink cannot escape the configured local boundary. Package names, URLs, absolute paths, traversal segments, and remote installation are not supported.

```json
{
  "plugins": {
    "timeoutMs": 5000,
    "allowlist": [
      {
        "id": "company-vault",
        "kind": "secret-provider",
        "path": "./plugins/company-vault.mjs"
      },
      {
        "id": "company-routing",
        "kind": "routing-matcher",
        "path": "./plugins/company-routing.mjs",
        "bindings": {
          "company-work": "work"
        }
      }
    ]
  }
}
```

Miftah starts a contained local host process to inspect the manifest before it creates an MCP server. The manifest `id`, `kind`, and `apiVersion: "1"` must exactly match the configuration entry. An incompatible or unreadable module fails with `PLUGIN_API_INCOMPATIBLE` before serving requests.

Each invocation uses a fresh contained host process with a scrubbed environment, argument arrays, no shell, bounded input/output, a timeout, and cancellation. On Windows it uses the existing kill-on-close Job Object path. A secret provider receives only `{ reference }`; it does not receive resolved configuration values, redaction controls, or other secret references. Its successful value is immediately registered with Miftah's redactor.

A routing matcher receives only `{ toolName, signals }`, where `signals` are the same bounded canonical provider identifiers used by Miftah's in-tree static matchers. Miftah deterministically deduplicates, sorts, and bounds the child request to at most 64 signals and 16 KiB; static matchers continue to evaluate the complete canonical input. A plugin does not receive raw tool arguments, general routing context, profile definitions, or secrets. A matcher returns configured binding tokens, not profile names; Miftah maps those tokens to the profiles in `plugins.allowlist[].bindings`.

Explicit environment/marker hints and `routing.rules` run before plugins. Static and plugin matcher candidates share the matcher-precedence band; different selected profiles fail closed with `ROUTING_AMBIGUOUS`. A plugin execution failure, timeout, or cancellation fails that request with a stable `ROUTING_PLUGIN_*` error and does not terminate upstream sessions or other MCP requests.

The child-host boundary withholds Miftah's in-memory context and isolates ordinary plugin exceptions and output from normal request handling; it is not a general operating-system sandbox. A same-user local module can still use Node filesystem, process, or network APIs, including actions that affect its parent or host. Treat every allowlisted module as operator-trusted code and review/pin it like any other executable; changes made after preflight are also within that trust boundary. `routing.plugins` remains unsupported; use the root `plugins.allowlist` only.

The in-tree [reference configuration](../examples/plugins.miftah.json), [file secret provider](../examples/plugins/file-secret-provider.mjs), and [GitHub-owner routing matcher](../examples/plugins/github-owner-routing-matcher.mjs) show the complete supported shape.
