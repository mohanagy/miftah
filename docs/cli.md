# CLI reference

Run the wrapper for an MCP client:

```bash
miftah --config ~/.config/miftah/github.json
miftah serve --config ~/.config/miftah/github.json
```

Inspect a config without starting an upstream:

```bash
miftah validate --config github.json
miftah schema
```

## Readiness diagnostics

Run readiness diagnostics before deploying a configured upstream:

```bash
miftah doctor --config github.json
```

The default report is human-readable. For automation, emit only the pretty-printed JSON report:

```bash
miftah doctor --json --config github.json
```

Reports are `healthy`, `degraded`, or `failed`. Every check has a stable `code`, `status`, `target`, `explanation`, and `remediation`. Doctor validates configuration and secret references, checks redaction, permissions and configured audit storage, and probes executable availability, upstream startup, discovery, and clean shutdown where applicable.

Doctor never emits resolved secret values, raw configuration paths, or configured upstream command arguments in its report. A `healthy` or `degraded` report exits `0`; warnings therefore do not block automation. A `failed` report has blocking checks and exits `1`.

Inspect or initialize an upstream:

```bash
miftah init github --preset github --output github.miftah.json
miftah list-tools --config github.miftah.json --profile work
miftah test-profile --config github.miftah.json --profile work
miftah logs --config github.miftah.json
```

Commands return non-zero status for unreadable, invalid, or unsafe configurations. Output is JSON where it is intended for scripts and never includes resolved secret values.
