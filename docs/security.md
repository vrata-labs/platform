# Security

## MVP baseline

- Use HTTPS and WSS outside local development.
- Keep secrets out of source control.
- Keep token TTL configurable.
- Gate XR, spatial audio, and screen share behind feature flags.
- Room runtime, room-state WebSocket, media token issuing, diagnostics, XR telemetry, and remote-browser frame token issuing use short-lived HMAC-signed room session tokens.
- Control-plane mutating/admin endpoints use deny-by-default AuthN/AuthZ with explicit permissions and audit logging. See [`docs/security/permissions.md`](./security/permissions.md).
- Runtime diagnostics use report IDs and request IDs with basic redaction for tokens, secrets, cookies, invites, and token-bearing URLs. See [`docs/observability.md`](./observability.md).
- Do not enable dev role query mode in production; production preflight rejects it.

## Experimental remote browser

- Remote browser is disabled by default when `NODE_ENV=production`. Enabling it requires `REMOTE_BROWSER_ENABLED=true`; the production profile additionally requires `VRATA_ALLOW_EXPERIMENTAL_SERVICES=true`.
- The production compose executor is also behind the `experimental` compose profile. An opt-in rollout must use `docker compose --profile experimental ...`; API and Caddy do not depend on that profile while the feature is disabled.
- Every top-level URL, redirect, and subresource request passes the configured `REMOTE_BROWSER_ALLOWED_ORIGINS` policy and private/reserved-address checks. Arbitrary internet browsing is not supported.
- Session creation, executor callbacks, and media token issuance use the separate `REMOTE_BROWSER_INTERNAL_TOKEN` boundary. Production fails closed when that scoped token is absent or incorrect.
- Executor session and media identities are bound to `remote-browser:<objectId>`. Mismatched room object/session/media identifiers are rejected.
- `REMOTE_BROWSER_SESSION_TTL_SECONDS`, `REMOTE_BROWSER_MAX_SESSIONS`, viewport bounds, container CPU/memory, and PID limits bound session lifetime and resource use.
- Compose attaches the executor only to a dedicated network shared with API, room-state, LiveKit, and Caddy; it is not attached to the Postgres or MinIO network path. API verifies every executor media/frame token request against the authoritative room object generation.
- The runtime always labels enabled remote browser controls as `Experimental`. Disable the flag immediately if executor abuse, SSRF attempts, or resource exhaustion is suspected.

## Still missing

- Persistent invite/session revocation beyond the current short-lived token boundary
- Per-tenant remote-browser quotas and external sandbox isolation beyond the current container boundary
- External structured logging pipeline and retention policy
