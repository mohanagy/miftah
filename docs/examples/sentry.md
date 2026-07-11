# Sentry

The strict Sentry catalog output is [`examples/sentry.miftah.json`](../../examples/sentry.miftah.json). Generate an equivalent configuration with:

```sh
miftah init sentry --preset sentry --output sentry.miftah.json
```

It runs `@sentry/mcp-server@0.36.0` with `--skills=inspect` and contains only the `${SENTRY_ACCESS_TOKEN}` reference. The upstream requires Node.js `>=20`, independently of Miftah’s own Node.js requirement.

`--skills=inspect` filters Sentry MCP CLI skills. It does not authorize a token, and it is not a read-only flag or preset. Use least-privilege Sentry token scopes; Miftah local policy cannot reduce provider-side token permissions.

See the [preset and client compatibility matrix](../presets-and-clients.md) for upstream sources, validation boundaries, and client snippets.
