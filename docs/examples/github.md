# GitHub

Use the generic wrapper to run GitHub MCP with separate work and personal tokens:

```json
{
  "version": "1",
  "name": "github",
  "defaultProfile": "work",
  "upstream": {
    "transport": "stdio",
    "command": "docker",
    "args": ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"]
  },
  "profiles": {
    "work": {
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_WORK_TOKEN}"
      },
      "policy": "safe-write"
    },
    "personal": {
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_TOKEN}"
      },
      "policy": "readonly"
    }
  },
  "policies": {
    "readonly": {
      "allowRisk": ["read"],
      "denyRisk": ["write", "destructive"]
    },
    "safe-write": {
      "allowRisk": ["read", "write"],
      "denyRisk": ["destructive"]
    }
  }
}
```

This config contains references only. Set the variables in the shell that launches Claude Desktop.
