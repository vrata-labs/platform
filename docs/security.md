# Security

## MVP baseline

- Use HTTPS and WSS outside local development.
- Keep secrets out of source control.
- Keep token TTL configurable.
- Gate XR, spatial audio, and screen share behind feature flags.
- Room runtime, room-state WebSocket, media token issuing, diagnostics, XR telemetry, and remote-browser frame token issuing use short-lived HMAC-signed room session tokens.
- Do not enable dev role query mode in production; production preflight rejects it.

## Still missing

- AuthN/AuthZ for control-plane actions
- Persistent invite/session revocation beyond the current short-lived token boundary
- Fine-grained permissions and abuse controls
- Structured production logging pipeline
