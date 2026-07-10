# Changelog

All notable changes to this project will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Package metadata and a verified npm pack-content contract.
- Least-privilege CI and OIDC trusted-publishing workflows.
- Dependency update, contribution, vulnerability-reporting, and repository templates.

### Changed

- Configuration now rejects unsupported lifecycle controls, state/UI settings, routing plugins and non-hybrid modes, profile metadata and matchers, per-profile upstream `transport`/`command`/`url` overrides, and configurable tool namespaces with `UNSUPPORTED_CONFIG_OPTION` instead of silently ignoring them. Remove those settings from existing configs; only `process.startupTimeoutMs` currently controls process lifecycle behavior.
- Secret and audit redaction remain force-on protections. Existing configs may retain `security.redactSecrets: true` and `audit.redact: true`, but setting either to `false` is now rejected.

## Release policy

Miftah is experimental and pre-1.0, so incompatible changes may occur between minor versions and must be called out here. For each release, maintainers move **Unreleased** entries into a dated version section, update `package.json` and `package-lock.json` together using npm tooling, and publish a GitHub release tagged `v<package-version>`. The release workflow publishes only after the tag, ancestry, tests, build, CLI smoke test, and package contents are verified.
