# Local Console dashboard and control API

Miftah includes an optional, local-only browser Console over its control API. It is a separate foreground process and listener from the MCP `/mcp` transport. Start the dashboard with:

```sh
miftah dashboard
```

Without `--config`, the dashboard discovers direct, validated Miftah JSON files in `~/.config/miftah` and asks the operator to select one. It does not scan Claude, Cursor, VS Code, process arguments, or arbitrary home directories. Candidate paths must be canonical regular files in that bounded directory; unsafe, malformed, duplicate, and symbolic candidates are omitted without exposing their paths or parser errors. Windows discovery additionally verifies the current-user owner and restrictive DACL; if that proof is unavailable, automatic discovery fails closed. A selection is bound to the verified file content: if the file changes, select it again rather than applying controls to a replacement. If no safe configuration exists, first-run onboarding creates `~/.config/miftah/miftah.json` only after explicit submission.

`miftah dashboard --config <file>` is different: it opens exactly that one configuration and does not show or scan a catalog. Use `--port <number>` for a fixed loopback port, or `--no-open` to print the URL without launching a browser. The API-only compatibility command remains:

```sh
miftah console --config ~/.config/miftah/service.json
```

Both commands bind literal `127.0.0.1` on an ephemeral port by default. There is no host option, LAN mode, background daemon, or automatic startup. Closing the foreground command stops the dashboard.

## First browser session

Startup prints the loopback URL and one CSPRNG-backed bootstrap code to the launching terminal. The code:

- is accepted once at `POST /api/v1/sessions` as `Authorization: Bootstrap <code>`;
- expires after five minutes and can be replaced by restarting the command or rotating the running host;
- is never placed in a URL, cookie, browser storage, browser response, audit record, or diagnostic; and
- is unrelated to MCP HTTP authentication and OAuth access or refresh tokens.

The Console page asks the operator to type this terminal code. A successful same-origin exchange returns an in-memory CSRF proof and sets an opaque `HttpOnly; SameSite=Strict` session cookie scoped to `/api/v1`. The cookie is a session handle, not the bootstrap credential. The CSRF proof remains in page memory and accompanies every later mutation as `X-Miftah-CSRF`; the UI does not persist it in localStorage or sessionStorage. A bootstrap cannot be replayed.

Browser sessions have a 15-minute idle limit and a one-hour absolute limit. Restarting, stopping, or rotating the control host invalidates them. Loopback HTTP cannot provide a meaningful `Secure` cookie flag, so exact Host and Origin validation, SameSite, HttpOnly, one-use bootstrap, CSRF, and short lifetime are all mandatory controls. A hostile process running as the same OS user remains outside this boundary.

## Version 1 endpoints

Every request must use the exact listener `Host`. Browser mutations, including bootstrap, must also use the exact listener `Origin`. Normal same-origin navigation and authenticated `GET` and `HEAD` requests may omit `Origin`, because browsers do not consistently attach it to read requests; hostile or duplicate Origin values are still rejected, cross-site cookies remain blocked by `SameSite=Strict`, and every mutation still requires exact Origin plus CSRF. Except for the bootstrap exchange and static application assets, every API endpoint requires the session cookie. JSON request bodies are capped at 64 KiB and must use `Content-Type: application/json`. Headers are capped at 16 KiB. The process admits at most 240 trusted requests per minute and only eight bootstrap attempts per minute; excess requests receive `429` plus `Retry-After`.

`POST /api/v1/sessions`, `POST /api/v1/connections/:ref/connect`, `POST /api/v1/connections/:ref/test`, `POST /api/v1/connections/:ref/reauth`, and `DELETE /api/v1/connections/:ref/credential` must send `Content-Type: application/json` with the JSON body `{}`. `POST /api/v1/connections` instead accepts a strict JSON object with required `profile`, `issuer`, `clientRegistration`, and `scopes` fields plus optional `connectionRef` and `upstream` fields; unknown fields are rejected. The first-run endpoint accepts only non-secret configuration name, profile, description, exact resource/issuer, client-registration mode, and scopes; token, password, cookie, secret, callback, and arbitrary extra fields are rejected.

| Method and path | Purpose |
| --- | --- |
| `POST /api/v1/sessions` | Exchange the one-use bootstrap code for one browser session. |
| `POST /api/v1/onboarding/preset` | Exclusively create the first validated configuration from a reviewed preset and safe connector metadata. Requires CSRF; raw credential values are rejected. |
| `POST /api/v1/onboarding/native-oauth` | Exclusively create the first validated v3 native-OAuth profile, upstream, and connection. Requires CSRF and refuses an existing file. |
| `GET /api/v1/health` | Return safe config identity, Console audit health, and restart-required guidance. |
| `GET /api/v1/config` | Return allowlisted configuration metadata only. |
| `GET /api/v1/configurations` | Return the no-config dashboard's bounded, metadata-only configuration catalog. Not available for an explicit `--config` Console. |
| `POST /api/v1/configurations/:id/select` | Select one opaque catalog entry for this Console process. Requires CSRF; it never changes MCP client files or live MCP sessions. |
| `GET /api/v1/profiles` | Return profile names, descriptions, tags, policy names, and named-upstream keys only. |
| `GET /api/v1/connections` | Return configured non-secret OAuth connection bindings without opening the vault. |
| `GET /api/v1/connections/:ref` | Return redacted credential and identity status for one exact connection. |
| `POST /api/v1/connections` | Atomically add one schema-valid OAuth connection binding. Requires CSRF. |
| `POST /api/v1/connections/:ref/connect` | Run the approved system-browser authorization for one exact connection. Requires CSRF. |
| `POST /api/v1/connections/:ref/test` | Test one exact configured connection without starting a new interactive authorization. Requires CSRF. |
| `POST /api/v1/connections/:ref/reauth` | Replace one exact credential without deleting the old credential before success. Requires CSRF. |
| `DELETE /api/v1/connections/:ref/credential` | Delete one exact local vault credential. Requires CSRF. Provider-side revocation is not claimed. |
| `GET /api/v1/audit?limit=1..200` | Return allowlisted metadata from the owner-restricted Console mutation journal, never raw JSONL or arguments. |
| `GET /api/v1/client-snippets?client=<name>` | Generate review-and-copy JSON for Claude Desktop, Claude Code, Cursor, VS Code, or `all`; never edit client files. |

Success responses use `{ "data": ... }`. Errors use `{ "error": { "code": "...", "message": "..." } }` with semantic HTTP status codes. Responses are non-cacheable and carry restrictive content-type, framing, referrer, and content-security headers. Internal paths, raw configuration, secret references, environment maps, command arguments, headers, tokens, authorization URLs, raw provider errors, and raw audit bytes are not part of the browser contract. For a recognized provider adapter, configuration metadata states only the declared authentication ownership; the Console hides the native OAuth editor rather than implying it can take over the adapter's OAuth cache.

## Mutation and process boundary

Connection creation reuses the same typed application service as the CLI: an existing candidate is schema-validated, applied from an exact source snapshot, backed up uniquely, and published through the guarded atomic replacement. First-run onboarding constructs and validates the complete v3 candidate before an exclusive, non-overwriting create. Console clears its selection after a configuration write, so choose the configuration again before another control operation; this prevents a concurrent replacement from being silently trusted. Console mutations use a separate owner-restricted, fail-closed journal under `.miftah/audit/console.jsonl` beside the configuration. If that journal cannot be prepared, the mutation is refused before its side effect.

The control API manages durable configuration and the local OAuth vault for future connections. It cannot inspect or take over another Miftah process, replace an active Claude Desktop STDIO session, or change that process's in-memory profile selection. Restart or reconnect the MCP client after a durable Console change. A future broker or IPC design would require a separate authenticated threat-model review.
