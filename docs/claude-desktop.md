# Claude Desktop

Install Miftah globally, create a wrapper config, and add one server entry:

```json
{
  "mcpServers": {
    "github": {
      "command": "miftah",
      "args": [
        "--config",
        "/Users/me/.config/miftah/github.json"
      ]
    }
  }
}
```

Claude Desktop generally provides one STDIO session per configured server. Profile state is therefore session-local in the default mode. Miftah cannot infer every detail of a conversation; use `miftah_use_profile` for explicit switching and configure routing rules for stable tool arguments such as repositories, organizations, or projects.

Do not configure every account as a separate Claude server. Give each wrapper one entry and keep account-specific credentials in profiles.
