# Security policy

Miftah handles credentials and sits on the MCP trust boundary. Treat suspected credential exposure, policy bypasses, secret-redaction failures, command injection, and dependency compromise as security issues.

## Supported versions

Miftah is experimental and pre-1.0. Security fixes are applied to the latest published version, when one exists; older pre-1.0 versions may require upgrading. The repository's default branches are development sources, not supported releases.

## Private reporting

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/mohanagy/miftah/security/advisories/new). Do not open a public issue, discussion, or pull request containing vulnerability details.

Include:

- the affected version or commit;
- impact and realistic attack prerequisites;
- minimal reproduction steps or a proof of concept;
- any known workarounds;
- whether credentials or third-party systems may have been exposed.

Remove real tokens, personal data, and unrelated customer data. Use disposable local credentials and accounts you are authorized to test. Do not disrupt services, access other users' data, or retain data beyond what is necessary to demonstrate the issue.

Maintainers aim to acknowledge a report within five business days, then coordinate validation, remediation, release timing, and credit. Please allow a reasonable remediation period before public disclosure. If the private reporting form is unavailable, contact a maintainer privately to request a secure channel without sharing vulnerability details publicly.

For the package's security boundaries and operating guidance, see [docs/security.md](docs/security.md) and the public [threat model](docs/threat-model.md).
