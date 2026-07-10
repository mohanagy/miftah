# CLI reference

Run the wrapper for an MCP client:

```bash
miftah --config ~/.config/miftah/github.json
miftah serve --config ~/.config/miftah/github.json
```

Inspect a config without starting an upstream:

```bash
miftah validate --config github.json
miftah doctor --config github.json
miftah schema
```

Inspect or initialize an upstream:

```bash
miftah init github --preset github --output github.miftah.json
miftah list-tools --config github.miftah.json --profile work
miftah test-profile --config github.miftah.json --profile work
miftah logs --config github.miftah.json
```

Commands return non-zero status for unreadable, invalid, or unsafe configurations. Output is JSON where it is intended for scripts and never includes resolved secret values.
