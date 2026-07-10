# Sentry

Sentry MCP can use the same wrapper pattern:

```json
{
  "version": "1",
  "name": "sentry",
  "defaultProfile": "work",
  "upstream": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@sentry/mcp-server"]
  },
  "profiles": {
    "work": {
      "env": {
        "SENTRY_AUTH_TOKEN": "${SENTRY_WORK_TOKEN}",
        "SENTRY_ORG": "work-org"
      }
    },
    "client-a": {
      "env": {
        "SENTRY_AUTH_TOKEN": "${SENTRY_CLIENT_A_TOKEN}",
        "SENTRY_ORG": "client-a"
      },
      "policy": "readonly"
    }
  },
  "policies": {
    "readonly": {
      "allowRisk": ["read"],
      "denyRisk": ["write", "destructive"]
    }
  }
}
```
