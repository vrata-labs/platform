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

## Still missing

- Persistent invite/session revocation beyond the current short-lived token boundary
- Fine-grained permissions and abuse controls
- External structured logging pipeline and retention policy
