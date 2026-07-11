# Claude Desktop

Generate a strict configuration and a Claude Desktop snippet:

```sh
miftah init github --preset github --output ~/.config/miftah/github.json --client claude-desktop
```

Miftah writes only `~/.config/miftah/github.json` in this example. It prints JSON for you to copy and does not create or overwrite a Claude Desktop configuration file.

Claude Desktop uses an `mcpServers` object and is officially available on macOS and Windows. Its normal locations are:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Use the installed app’s **Developer → Edit Config** flow as the source of truth for the actual location and schema. Merge the generated top-level `mcpServers` property into the host config. If the host config already has an `mcpServers` object, merge the generated server entry into that object instead of nesting another `mcpServers` property. Do not convert its absolute command and argument paths into a shell command. The launcher uses absolute Node and compiled Miftah CLI paths because desktop GUI processes often have a different `PATH` than a terminal.

Regenerate the snippet after moving or upgrading Miftah, or changing the Miftah config path. Keep credentials outside both JSON files; set only the generated `${ENV_NAME}` references in the environment that launches Claude Desktop.

Claude Desktop generally provides one STDIO session per configured server. Profile state is therefore session-local in the default mode. Miftah cannot infer every detail of a conversation; use `miftah_use_profile` for explicit switching and configure routing rules for stable tool arguments such as repositories, organizations, or projects.

Do not configure every account as a separate Claude server. Give each wrapper one entry and keep account-specific credentials in profiles. For catalog pins, safety boundaries, and all client destinations, see [preset and client compatibility](presets-and-clients.md).
