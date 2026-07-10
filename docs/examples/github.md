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
    "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server:v1.1.0"]
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

When upgrading the pinned image tag, review upstream release notes first, then run `miftah validate --config <file>` and test both profiles before adopting the new tag.
