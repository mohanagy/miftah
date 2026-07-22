# Local Console control API

Miftah includes an optional, local-only control API for the Console UI. It is a separate process and listener from the MCP `/mcp` transport. It starts only when an operator runs:

```sh
miftah console --config ~/.config/miftah/service.json
```

The command binds literal `127.0.0.1` on an ephemeral port by default. `--port <number>` selects a fixed loopback port. There is no host option, LAN mode, background daemon, or automatic startup.

## First browser session

Startup prints the loopback URL and one CSPRNG-backed bootstrap code to the launching terminal. The code:

- is accepted once at `POST /api/v1/sessions` as `Authorization: Bootstrap <code>`;
- expires after five minutes and can be replaced by restarting the command or rotating the running host;
- is never placed in a URL, cookie, browser storage, browser response, audit record, or diagnostic; and
- is unrelated to MCP HTTP authentication and OAuth access or refresh tokens.

The Console page introduced separately asks the operator to type this terminal code. A successful same-origin exchange returns an in-memory CSRF proof and sets an opaque `HttpOnly; SameSite=Strict` session cookie scoped to `/api/v1`. The cookie is a session handle, not the bootstrap credential. The CSRF proof must remain in page memory and accompany every later mutation as `X-Miftah-CSRF`; the UI must not persist it in localStorage or sessionStorage. A bootstrap cannot be replayed.

Browser sessions have a 15-minute idle limit and a one-hour absolute limit. Restarting, stopping, or rotating the control host invalidates them. Loopback HTTP cannot provide a meaningful `Secure` cookie flag, so exact Host and Origin validation, SameSite, HttpOnly, one-use bootstrap, CSRF, and short lifetime are all mandatory controls. A hostile process running as the same OS user remains outside this boundary.

## Version 1 endpoints

Every request must use the exact listener `Host` and `Origin`. Except for the bootstrap exchange, every endpoint requires the session cookie. JSON request bodies are capped at 64 KiB and must use `Content-Type: application/json`. Headers are capped at 16 KiB. The process admits at most 240 trusted-origin requests per minute and only eight bootstrap attempts per minute; excess requests receive `429` plus `Retry-After`.

| Method and path | Purpose |
| --- | --- |
| `POST /api/v1/sessions` | Exchange the one-use bootstrap code for one browser session. |
| `GET /api/v1/health` | Return safe config identity, Console audit health, and restart-required guidance. |
| `GET /api/v1/config` | Return allowlisted configuration metadata only. |
| `GET /api/v1/profiles` | Return profile names, descriptions, tags, policy names, and named-upstream keys only. |
| `GET /api/v1/connections` | Return configured non-secret OAuth connection bindings without opening the vault. |
| `GET /api/v1/connections/:ref` | Return redacted credential and identity status for one exact connection. |
| `POST /api/v1/connections` | Atomically add one schema-valid OAuth connection binding. Requires CSRF. |
| `POST /api/v1/connections/:ref/connect` | Run the approved system-browser authorization for one exact connection. Requires CSRF. |
| `POST /api/v1/connections/:ref/reauth` | Replace one exact credential without deleting the old credential before success. Requires CSRF. |
| `DELETE /api/v1/connections/:ref/credential` | Delete one exact local vault credential. Requires CSRF. Provider-side revocation is not claimed. |
| `GET /api/v1/audit?limit=1..200` | Return allowlisted metadata from the owner-restricted Console mutation journal, never raw JSONL or arguments. |

Success responses use `{ "data": ... }`. Errors use `{ "error": { "code": "...", "message": "..." } }` with semantic HTTP status codes. Responses are non-cacheable and carry restrictive content-type, framing, referrer, and content-security headers. Internal paths, raw configuration, secret references, environment maps, command arguments, headers, tokens, authorization URLs, raw provider errors, and raw audit bytes are not part of the browser contract.

## Mutation and process boundary

Connection creation reuses the same typed application service as the CLI: the candidate is schema-validated, applied from an exact source snapshot, backed up uniquely, and published through the guarded atomic replacement. Console mutations use a separate owner-restricted, fail-closed journal under `.miftah/audit/console.jsonl` beside the configuration. If that journal cannot be prepared, the mutation is refused before its side effect.

The control API manages durable configuration and the local OAuth vault for future connections. It cannot inspect or take over another Miftah process, replace an active Claude Desktop STDIO session, or change that process's in-memory profile selection. Restart or reconnect the MCP client after a durable Console change. A future broker or IPC design would require a separate authenticated threat-model review.
