# Security

## MVP baseline

- Use HTTPS and WSS outside local development.
- Keep secrets out of source control.
- Keep token TTL configurable.
- Gate XR, spatial audio, and screen share behind feature flags.
- Treat current API tokens as development placeholders only.

## Still missing

- Signed tokens
- AuthN/AuthZ for control-plane actions
- Fine-grained permissions and abuse controls
- Structured production logging pipeline
