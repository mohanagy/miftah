# Contributing

Miftah is a security-sensitive credential broker. Changes should preserve least privilege, fail closed when routing or policy is ambiguous, and never expose credentials in code, fixtures, logs, errors, or review artifacts.

## Development

Use Node.js 20 or newer and the npm version represented by `package-lock.json`.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
node dist/cli/main.js schema
npm run check:pack
```

Write a failing Vitest test before changing behavior or a configuration contract, then make the smallest implementation that passes. Tests must exercise real behavior; production paths must not depend on mocks or test-only switches.

## Pull requests

- Open focused pull requests against `development`; maintainers promote release-ready changes to `main`.
- Describe the threat-model or credential-handling impact, including why the change fails safely.
- Add tests for changed behavior and update user-facing documentation.
- Update `CHANGELOG.md` under **Unreleased** for user-visible changes.
- Use synthetic, redacted fixtures. Never paste real tokens, environments, audit data, or private vulnerability details.
- Run the full verification sequence above and record relevant evidence.
- Use the private process in `SECURITY.md` instead of a pull request for undisclosed vulnerabilities.

Repository workflows provide checks, but they do not configure or prove GitHub rulesets, environment protection, or npm account settings.

## Release policy

Only maintainers release. A release commit on `main` must contain the intended SemVer package version and finalized changelog entry. A published GitHub release tagged `v<package-version>` triggers `.github/workflows/publish.yml`; the workflow verifies the tag is reachable from `main`, reruns all checks, and publishes with npm provenance. Do not run `npm publish` manually as the normal release path.

### One-time dashboard configuration

These controls are external setup, not secrets or settings that workflow YAML can enforce:

1. In GitHub, create and protect the GitHub `npm` environment used by the publish job. Add required reviewers and deployment tag rules appropriate to the maintainers' release policy.
2. In npm package settings, configure an **npm trusted publisher** for repository `mohanagy/miftah`, workflow `.github/workflows/publish.yml`, and environment `npm`.
3. Configure GitHub branch protection or rulesets for `development` and `main`, including pull-request review and the CI `Verify` check as appropriate. Branch protection must be confirmed in the GitHub dashboard; it is not enabled by `ci.yml`.
4. Enable GitHub private vulnerability reporting so the path in `SECURITY.md` is available.

Trusted publishing uses short-lived OIDC identity. Never commit or add an `NPM_TOKEN` for this workflow.
