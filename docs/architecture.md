# Architecture

Miftah is an MCP-aware proxy, not a byte-level reverse proxy:

```text
MCP client
  -> Miftah STDIO server
     -> config and secret resolver
     -> profile state
     -> routing and policy
     -> cached upstream MCP client
        -> upstream STDIO server
```

The public server is built with the official `@modelcontextprotocol/sdk` `Server` and `StdioServerTransport`. Each profile gets an SDK `Client` and `StdioClientTransport` on first use. A single-flight start map prevents concurrent calls from launching duplicate processes. Tool discovery is held in immutable, per-profile capability snapshots; concurrent callers share one discovery operation, and a snapshot is published only after all upstream discovery and collision checks complete. A call captures its active profile before discovery, so a later profile switch cannot change that call's active-profile fallback.

The server advertises management tools plus tools discovered from the active profile. It advertises `tools.listChanged` and emits `notifications/tools/list_changed` after profile changes or an active-profile restart when a client must re-list. Unknown names are rejected from the capability snapshot rather than guessed or forwarded. If a routing rule targets another profile, Miftah forwards only when that profile exposes the same name with an identical client-visible schema; otherwise it returns `TOOL_SCHEMA_MISMATCH`. A standard `upstream` and a named `upstreams` map with exactly one entry proxy resources and prompts through that sole upstream. A zero-entry map and a map with two or more entries omit the MCP `resources` and `prompts` capabilities and do not register their handlers; direct resource or prompt requests then receive the standard `-32601` method-not-found response. This prevents Miftah from accidentally selecting the first upstream when aggregation and namespacing are unavailable. `miftah_health` reports `resourcePromptProxy` availability and its reason, which is also included in the server instructions when disabled. Reserved management tool names are protected; the default collision strategy prefixes a conflicting upstream name with `upstream_`.

Configuration and runtime concerns are intentionally separate:

- `config/` parses and validates JSON, expands paths, and provides schema output.
- `secrets/` resolves local references and owns redaction.
- `profiles/` owns active profile state and switching restrictions.
- `routing/` resolves explicit rules and safe fallbacks.
- `policy/` classifies tool risk and returns allow/deny/confirm decisions.
- `upstream/` owns child processes, MCP initialization, caching, health, and cleanup.
- `audit/` writes local JSONL metadata only.
- `mcp/server/` adapts those services to MCP operations and management tools.

The design leaves transport and multi-upstream seams in the config and interfaces. Remote transports should be added as separate upstream session implementations rather than weakening the STDIO security defaults.
