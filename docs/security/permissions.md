# Control Plane Permissions

## Identity Sources

Control-plane protected actions accept one of two identities:

- `x-vrata-admin-token: <CONTROL_PLANE_ADMIN_TOKEN>` for self-host/operator administration.
- `Authorization: Bearer <room-session-token>` for signed room-session actors issued by `POST /api/tokens/state`.

Missing identity returns `401`. Invalid tokens also return `401`. A valid identity without the required permission returns `403`.

Room-session host permissions require a trusted role source in the signed token. Tokens minted through dev-role query mode (`?role=host` / `requestedRole=host`) are valid runtime tokens but are not trusted for control-plane host-owned actions.

## Permission Matrix

| Permission | Endpoint group | Admin token | Host room session | Member | Guest |
| --- | --- | --- | --- | --- | --- |
| `tenant.write` | `POST/PATCH/DELETE /api/tenants` | yes | no | no | no |
| `room.create` | `POST /api/rooms` | yes | no | no | no |
| `room.update` | `PATCH /api/rooms/:roomId` | yes | no | no | no |
| `room.bind-scene-bundle` | `POST /api/rooms/:roomId/bind-scene-bundle` | yes | own room only | no | no |
| `room.delete` | `DELETE /api/rooms/:roomId` | yes | no | no | no |
| `asset.write` | `POST/PATCH/DELETE /api/assets` | yes | no | no | no |
| `scene-bundle.write` | scene-bundle create/version/status/current endpoints | yes | no | no | no |
| `xr-telemetry.read` | `GET /api/rooms/:roomId/xr-telemetry` | yes | own room only | no | no |
| `audit.read` | `GET /api/audit/control-plane` | yes | no | no | no |

Signed room-session roles are not operator identities. A signed room-session token with role `admin` is still denied for control-plane admin permissions unless the request uses the `CONTROL_PLANE_ADMIN_TOKEN` header.

Invite-link lifecycle endpoints are not part of the current API surface. `VRATA-FEAT-014` owns private room access and invite create/revoke/use behavior; when those endpoints are added, they must declare explicit permissions and write control-plane audit entries.

## Public Runtime Endpoints

Runtime boot/read endpoints stay public by design and must not mutate tenant or room state:

- `GET /health`, `GET /health/ready`
- runtime and control-plane static assets
- `GET /api/templates`
- `GET /api/assets`
- `GET /api/tenants`
- `GET /api/rooms`
- `GET /api/rooms/:roomId`
- `GET /api/rooms/:roomId/manifest`
- `GET /api/rooms/:roomId/spaces`
- `GET /api/rooms/:roomId/presence`
- `GET /api/rooms/:roomId/diagnostics`
- scene-bundle list/read endpoints

## Audit Log

Every protected control-plane authorization decision writes a structured audit event to stdout and to a bounded in-memory inspection log.

Audit entries include:

- `requestId`
- `action`
- `permission`
- `object.type` and optional `object.id`
- `result` (`allowed` or `denied`)
- `reason` for denied requests
- `actor` without raw tokens or secrets

Use `x-request-id` to correlate client requests with audit entries.
