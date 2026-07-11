# GitHub

The strict GitHub catalog output is [`examples/github.miftah.json`](../../examples/github.miftah.json). Generate an equivalent configuration with:

```sh
miftah init github --preset github --output github.miftah.json
```

It runs Docker STDIO with the exact `ghcr.io/github/github-mcp-server:v1.5.0` tag, `--read-only`, and `--toolsets=repos,issues,pull_requests`. The example contains only `${GITHUB_WORK_TOKEN}` and `${GITHUB_PERSONAL_TOKEN}` references; provide least-privilege GitHub provider tokens outside the JSON.

The tag is intentionally not presented as a digest. Before reproducible production deployment, use an authenticated promotion process and record the resolved image digest in deployment records; do not invent one. Miftah’s local policy cannot make a write-capable provider token read-only.

See the [preset and client compatibility matrix](../presets-and-clients.md) for upstream links, digest guidance, validation boundaries, and client snippets.
