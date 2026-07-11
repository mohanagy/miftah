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

The public server is built with the official `@modelcontextprotocol/sdk` `Server` and `StdioServerTransport`. Each profile/upstream pair gets an SDK `Client` and its configured transport on first use: local processes use `StdioClientTransport`, while remote upstreams use the matching SSE or streamable HTTP client transport. Per-profile start and restart single-flight state, attempt tokens, and lifecycle generations prevent concurrent calls or stale transport close events from creating duplicate children or replacing a newer session. Operations report begin/end activity so idle shutdown cannot close an in-flight request. Unexpected close is health `failed`; idle, explicit restart, wrapper shutdown, and timeout-enforced shutdown are intentional `stopped` states with a reason. Optional crash recovery uses bounded exponential backoff with jitter and a terminal retry budget; it retains its capacity reservation across the backoff window. A shared no-eviction limiter counts distinct profile bundles across named upstreams, so capacity pressure returns a typed refusal instead of terminating a live credential session. Tool discovery is held in immutable, per-profile capability snapshots; concurrent callers share one discovery operation. Complete snapshots are cached, while a permissive partial snapshot remains callable but is retried by the next tool list or call request. A call captures its active profile before discovery, so a later profile switch cannot change that call's active-profile fallback.

The server advertises management tools plus tools discovered from the active profile. It advertises `tools.listChanged` and emits `notifications/tools/list_changed` after profile changes, restarts, and recovery that changes the public tool snapshot. Unknown names are rejected from the capability snapshot rather than guessed or forwarded. If a routing rule targets another profile, Miftah forwards only when that profile exposes the same name with an identical client-visible schema; otherwise it returns `TOOL_SCHEMA_MISMATCH`. In strict discovery mode, Miftah preflights every configured profile and rejects unavailable upstreams or any mismatched exposed tool contract before publishing a snapshot.

Every proxied tool call, resource read, and prompt retrieval enters `OperationPipeline`. It captures the source profile state before awaiting work, resolves routing against that fixed active-profile fallback, evaluates the selected profile policy, resolves the exact target upstream route, executes, redacts the result or error, and emits one terminal operation audit record when audit logging is configured. Tools retain their original upstream names for routing and policy compatibility; resource reads and prompt retrieval use the stable policy names `resources/read` and `prompts/get`. Denied, confirmation-required, blocked, and ambiguous operations never resolve or execute an upstream read/get route.

For a multi-entry `upstreams` map, `ResourcePromptRegistry` discovers resources and prompts from every configured upstream and publishes namespaced public values only after collision checks succeed. It names resources and prompts `<upstream>__<name>`, and exposes resources as `miftah://resource/<encoded-upstream>?uri=<encoded-redacted-upstream-uri>`. The registry retains the original upstream URI privately with the exact profile and upstream route. Prompt resource links and read-result sub-resources are registered as exact Miftah routes to their originating upstream. Before resource/prompt URI metadata crosses the boundary, structural redaction strips userinfo/fragments and redacts query values, including URI metadata returned by reads and prompt content. After the operation pipeline authorizes its selected profile, a read or prompt get resolves that exact route and forwards only to its originating upstream; unknown identifiers are rejected rather than forwarded. Aggregate pagination stores the individual upstream cursors behind opaque, bounded in-memory LRU state scoped to the profile and capability kind.

The server advertises `resources.listChanged` and `prompts.listChanged` with `tools.listChanged`, and emits the matching notification when aggregate availability changes through a failure or recovery. Clients must re-list because route maps and aggregate cursors are profile-local and invalidated on profile changes, restarts, and unexpected upstream loss. A standard `upstream` and a named `upstreams` map with exactly one entry proxy resources and prompts through that sole upstream while preserving credential-free raw URIs, names, and cursors; URI and icon fields with userinfo, query values, or fragments are structurally redacted. A zero-entry map omits the MCP `resources` and `prompts` capabilities and does not register their handlers; direct resource or prompt requests then receive the standard `-32601` method-not-found response. Permissive multi-upstream discovery returns only healthy contributions and removes failed upstream routes; all-failed capability discovery returns `UPSTREAM_DISCOVERY_FAILED`. Strict mode rejects a partial aggregate. `miftah_health` exposes redacted process and per-capability discovery state for each started upstream. Reserved management tool names are protected; the default collision strategy prefixes a conflicting upstream name with `upstream_`.

Configuration and runtime concerns are intentionally separate:

- `config/` parses and validates JSON, expands paths, and provides schema output.
- `secrets/` resolves local references and owns redaction.
- `profiles/` owns active profile state and switching restrictions.
- `routing/` resolves explicit rules and safe fallbacks.
- `policy/` classifies proxied-operation risk and returns allow/deny/confirm decisions.
- `upstream/` owns child processes, MCP initialization, caching, health, and cleanup.
- `audit/` writes local JSONL metadata only.
- `mcp/server/` adapts those services to MCP operations and management tools.

The design leaves transport and multi-upstream seams in the config and interfaces. Remote transports should be added as separate upstream session implementations rather than weakening the STDIO security defaults.
