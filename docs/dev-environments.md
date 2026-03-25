# Dev Environments

## Environment matrix

### Local

- `apps/runtime-web`: local client runtime
- `apps/api`: local HTTP API
- `apps/room-state`: local room-state service
- `LiveKit`: local or dockerized single-node instance
- `Postgres`: local or dockerized instance for future control-plane persistence

### Staging

- Shared managed environment in Yandex Cloud
- Public HTTPS/WSS endpoints
- Same room flow as local, but with public routing and observability

## Secret management rules

- Do not commit real API keys or secrets.
- Keep local defaults in `.env.example` only as placeholders.
- Staging secrets must be injected by the deployment environment.
- Token TTL and CORS origin policy must remain configurable via environment variables.

## Initial config surface

- `API_PORT`
- `API_PUBLIC_URL`
- `API_CORS_ORIGIN`
- `STATE_TOKEN_TTL_SECONDS`
- `MEDIA_TOKEN_TTL_SECONDS`
- `ROOM_STATE_PORT`
- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `POSTGRES_URL`
