# Pull request

## Summary

Describe the focused change and why it is needed.

## Security impact

Explain changes to credential handling, routing, policy enforcement, redaction, audit data, subprocesses, dependencies, and failure behavior. Write “none” only after considering each boundary.

## Validation

List the exact commands and relevant results.

- [ ] A failing test was observed first for each behavior or configuration-contract change.
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `node dist/cli/main.js schema`
- [ ] `npm run check:pack`
- [ ] Fixtures, logs, screenshots, and examples contain no credentials or private data.
- [ ] User-facing documentation and `CHANGELOG.md` are updated when applicable.
- [ ] Dependency and packaged-file changes are intentional and reviewed.
- [ ] Undisclosed vulnerabilities are reported privately instead of in this pull request.
