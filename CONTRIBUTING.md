# Contributing

Miftah is a security-sensitive credential broker. Changes should preserve least privilege, fail closed when routing or policy is ambiguous, and never expose credentials in code, fixtures, logs, errors, or review artifacts.

## Development

Use Node.js 20 or newer and the npm version represented by `package-lock.json`.

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run smoke:cli
npm run check:pack
```

Write a failing Vitest test before changing behavior or a configuration contract, then make the smallest implementation that passes. Tests must exercise real behavior; production paths must not depend on mocks or test-only switches.

## Verification matrix

CI supports Node.js 20, 22, and 24. Every supported Node version runs `test:core` and `test:cli` on Ubuntu, macOS, and Windows. Linux on Node.js 20 runs the complete quality sequence once, including linting, type-checking, the full integration suite, V8 coverage thresholds for security-critical runtime boundaries, package verification, and the installed-tarball entry point and binary contract.

The final `Verify` job requires both the Linux quality job and every compatibility matrix entry to succeed. Keep its name stable: branch protection requires this check on `development` and `main`.

`tests/package-contract.test.ts` creates a real `npm pack` tarball, installs it in a temporary directory, imports its public entry point, and executes its installed `miftah schema` binary. Do not replace this with a source-tree-only smoke test.

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

Only maintainers release. Select the next SemVer version from the version actually published to npm and all user-visible changes since that version. A patch release contains compatible fixes only; before `1.0.0`, an intentional public API incompatibility requires a minor release.

All implementation and maintenance pull requests target `development`. Finalize the package version, `package-lock.json`, and dated changelog entry there, run the release checks, and obtain current-head CI and review approval. The only permitted `main` pull request is a reviewed release promotion from `development` to `main`. Never run `npm publish` from a workstation or a feature branch. Never publish from `development`.

After the reviewed promotion is merged, create a GitHub Release for `v<package-version>` at that `main` commit. That triggers `.github/workflows/publish.yml`, which verifies the tag is reachable from `main`, reruns the release checks, and invokes `npm publish --access public --provenance`.

**npm trusted publishing still runs `npm publish`.** It gives that GitHub Actions command a short-lived OIDC identity from the protected `npm` environment instead of a long-lived `NPM_TOKEN`. Never commit, add, or depend on an `NPM_TOKEN` for this release path.

After the workflow succeeds, complete all post-publish steps: Verify the registry version and provenance after publication, verify the GitHub Release and workflow evidence, and deprecate every superseded unsafe published version before closing the release issue.

### One-time dashboard configuration

These controls are external setup, not secrets or settings that workflow YAML can enforce:

1. In GitHub, create and protect the GitHub `npm` environment used by the publish job. Add required reviewers and deployment tag rules appropriate to the maintainers' release policy.
2. In npm package settings, configure an **npm trusted publisher** for repository `mohanagy/miftah`, workflow `.github/workflows/publish.yml`, and environment `npm`.
3. Configure GitHub branch protection or rulesets for `development` and `main`, including pull-request review and the CI `Verify` check as appropriate. Branch protection must be confirmed in the GitHub dashboard; it is not enabled by `ci.yml`.
4. Enable GitHub private vulnerability reporting so the path in `SECURITY.md` is available.

Trusted publishing uses short-lived OIDC identity. Never commit or add an `NPM_TOKEN` for this workflow.
