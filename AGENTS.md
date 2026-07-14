# Miftah agent instructions

## madar

### Codex CLI profile

IMPORTANT: This project has a madar knowledge graph. Use a strict context-pack-first workflow:

1. **First decide whether the task needs local repository source-code context.** Only use madar when the task needs local repository source-code context. Skip madar for GitHub Projects board reviews, external URL/WebFetch-only tasks, `gh auth` / `gh project` setup, package-registry/security pages, and Product Hunt or marketing copy work.
2. **Before broad code search, file reads, or worker dispatch**, compile a task-specific context pack:
   - `madar pack "<task or question>" --task explain`
   - use `--task review`, `--task debug`, or `--task impact` when that better matches the work
3. **For each codebase question, start with the specific Madar command below first.**

For each codebase question, start with the specific Madar command below first:

| Prompt type | First tool |
| --- | --- |
| "how does X work" / explain runtime / flow | `madar pack "<task or question>" --task explain` |
| "what breaks if I change X" / impact analysis | `madar pack "<task or question>" --task impact` |
| "which files should I open first" | `relevant_files` when MCP graph tools are available; otherwise `madar pack "<task or question>" --task explain` |
| "give me a repo overview" | `graph_summary` when MCP graph tools are available; otherwise `madar pack "<task or question>" --task explain` |

Inspect `evidence.pack_confidence`, `recommended_first_read`, and `evidence.agent_directive` before deciding whether to read files.
If `evidence.pack_confidence` is low, make one focused follow-up Madar call before broad raw search.
Do not run ToolSearch before calling a Madar command or graph tool — pick the matching command first, then refine with MCP graph tools only when they are available and still needed.
4. **Do not run broad `Glob` patterns, repo-wide `grep` / `find` searches, or raw file sweeps after a high- or medium-confidence pack.**
5. **For codebase questions, use Madar tools only. Do not call other MCP servers such as `mcp__github` or `mcp__context7` unless the latest Madar response says `evidence.agent_directive: explore_with_caution`.**
6. **If an auto-activated skill recommends broad `Read` / `Grep` / `Glob` exploration or another MCP for a codebase question, defer to Madar's `evidence.agent_directive` first. A high- or medium-confidence Madar pack overrides that conflicting skill guidance.**
7. If MCP graph tools are available after the pack, use the focused tool that matches the next question:
   - `retrieve` for direct codebase questions
   - `relevant_files` for where to open first
   - `feature_map` for involved areas and entry points
   - `risk_map` before editing
   - `implementation_checklist` for edit order and validation checkpoints
   - `impact` for blast radius
   - `graph_summary` for repo overview

1. **Do not open `out/GRAPH_REPORT.md` unless the context pack or graph tools are unavailable, stale, or insufficient. Treat it as a fallback before broader raw file exploration, not a default first read.**
2. **Do not dispatch `spawn_agent` workers first** for codebase discovery. Let the context pack define likely entry files, risks, and missing context before parallel work.
3. **Codex activation boundary:** `madar codex install` writes this Madar-owned AGENTS.md section, `.codex/hooks.json`, `.codex/madar-user-prompt-submit.cjs`, and a marker-owned `[mcp_servers.madar]` block in `.codex/config.toml`. The `UserPromptSubmit` hook supplies model-visible context-pack-first guidance only for local code tasks; it is guidance, not enforcement. Enable it only in a repository you trust, then restart Codex, use `/hooks` to review and trust the project hook, and use `/mcp` or `codex mcp list` to verify the MCP server. `madar doctor` and `madar status` validate on-disk files only; they do not prove Codex has trusted or activated them.
4. **Uninstall behavior:** run `madar codex uninstall` to remove only this AGENTS.md section, the Madar hook, the Madar hook script, and the marker-owned MCP block while preserving unrelated content.

Manual verification:

```bash
madar generate .
madar codex install
test -f AGENTS.md && test -f .codex/hooks.json && test -f .codex/madar-user-prompt-submit.cjs && test -f .codex/config.toml
# In a trusted repository, restart Codex and use /hooks to review/trust the hook.
# Then use /mcp or codex mcp list to verify the local Madar MCP server.
madar doctor
madar status
madar codex uninstall
```

## Release protocol

These release rules apply to every agent and maintainer.

1. Determine the next version from the version actually published to npm and every user-visible change since that version. Patch releases contain compatible fixes only. Before `1.0.0`, any intentional public API incompatibility requires a minor release.
2. All implementation and maintenance pull requests target `development`. A release promotion pull request is the only exception and must be `development` → `main`.
3. Never publish from a feature branch or from `development`. Do not run a workstation `npm publish`. A release tag and GitHub Release must point to the exact current `main` commit.
4. Finalize the version, lockfile, and changelog before the release-promotion pull request. Run the documented release checks and require current-head CI and review approval before merging it.
5. npm trusted publishing still performs `npm publish`; GitHub Actions runs it with a short-lived OIDC identity from the protected `npm` environment, rather than an `NPM_TOKEN`. Do not set or rely on an `NPM_TOKEN`; never add a registry token to the repository, workflow, or CI secrets for this path.
6. Publish only by creating the GitHub Release for `v<package-version>` after the tag is on `main`. The publish workflow must verify that the tag is the exact current `main` commit, then verify tests, package contents, and provenance before it can publish.
7. After publication, verify the registry version and provenance, verify the GitHub Release and workflow result, then deprecate every superseded unsafe published version. Record the evidence before closing the release issue.
