# Observability Baseline

Vrata exposes a small self-host friendly observability surface without requiring a vendor APM stack.

## Correlation IDs

- HTTP services accept `x-request-id` and echo it in the response.
- If the caller does not send `x-request-id`, the service generates one.
- Runtime diagnostic reports store both `reportId` and `requestId` so an operator can connect a browser-visible report with API logs.

## Health Endpoints

- API: `/health/live`, `/health/ready`, `/health`.
- Room-state: `/health/live`, `/health/ready`, `/health`.
- Remote-browser: `/health/live`, `/health/ready`, `/health`.
- `/health/live` means the process can answer HTTP.
- `/health/ready` means the service has completed its minimal dependency checks for the current profile.

## Metrics Endpoints

Metrics are Prometheus text format and safe to scrape from the trusted operator network.

- API: `/metrics`
- Room-state: `/metrics`
- Remote-browser: `/metrics`

Current baseline metrics include:

- `vrata_api_requests_total`
- `vrata_api_request_failures_total`
- `vrata_rooms_total`
- `vrata_active_rooms`
- `vrata_active_participants`
- `vrata_diagnostic_reports_created_total`
- `vrata_room_join_failures_total{reason}`
- `vrata_media_join_failures_total{reason}`
- `vrata_room_state_requests_total`
- `vrata_room_state_request_failures_total`
- `vrata_room_state_active_rooms`
- `vrata_room_state_active_participants`
- `vrata_room_state_disconnects_total`
- `vrata_remote_browser_requests_total`
- `vrata_remote_browser_request_failures_total`
- `vrata_remote_browser_sessions`
- `vrata_remote_browser_frame_clients`
- `vrata_remote_browser_media_clients`
- `vrata_remote_browser_disconnects_total`

## Runtime Report IDs

Runtime diagnostics POST to `/api/rooms/:roomId/diagnostics` using the signed room session token.

The API returns:

```json
{
  "ok": true,
  "reportId": "rpt_...",
  "requestId": "..."
}
```

The runtime stores the latest values in `window.__VRATA_DEBUG__.lastReportId` and `window.__VRATA_DEBUG__.lastReportRequestId`. When an issue report is created, the HUD shows `Report ID: rpt_...`.

Unhandled runtime errors create a client-side `rpt_*` before reporting so the user still has a stable support reference.

## Public Connectivity Diagnostics

The runtime serves a self-host friendly diagnostics page at `/diagnostics`. Operators can open `/diagnostics?roomId=<roomId>` from the app origin, or use the `Connectivity diagnostics` link in the room HUD.

The page creates a redacted JSON report with stable check codes for:

- API reachability: `api_ok`, `api_unreachable`, `api_http_error`.
- Admin diagnostics protection: `admin_details_protected`, `admin_details_public`.
- Room manifest and state token: `manifest_ok`, `manifest_unreachable`, `state_token_ok`, `state_token_failed`.
- Room-state WebSocket: `room_state_ws_ok`, `room_state_ws_failed`.
- Object storage: `storage_ok`, `storage_skipped`, `storage_unreachable`.
- Browser microphone: `microphone_ok`, `microphone_skipped`, `microphone_unsupported`, `microphone_permission_denied`, `microphone_not_found`, `microphone_check_failed`.
- LiveKit/WebRTC: `media_ok`, `media_skipped`, `media_token_failed`, `livekit_connect_failed`.
- Timeouts: `connectivity_check_timeout`.

Useful query parameters:

- `roomId=<roomId>` selects the room, default `demo-room`.
- `autorun=1` starts checks immediately.
- `skipMic=1` avoids a microphone permission prompt.
- `skipMedia=1` skips the LiveKit/WebRTC publish check.
- `timeoutMs=<number>` changes per-check timeout.

The LiveKit check publishes a generated diagnostics audio track instead of using microphone capture. The microphone check remains separate so a denied microphone can report `microphone_permission_denied` without hiding media transport status.

## Redaction

Structured API logs and runtime diagnostic payloads redact common sensitive fields and token-bearing URL query parameters.

Redacted examples:

- `authorization`
- `cookie`
- `password`
- `secret`
- `token`
- `invite`
- URL query parameters such as `?token=...`
- URL query parameters containing token-like key names such as `accessToken=...`

Short dotted action names such as `scene-bundle.version.create` are not treated as tokens.

## Investigation Flow

1. Ask the user for the `Report ID` shown in the room HUD.
2. Search API logs for `event=runtime_diagnostic_report` and that `reportId`.
3. Use `requestId` from the same event to correlate HTTP logs or reverse proxy logs.
4. Check `/metrics` for the related failure counter, for example `vrata_room_join_failures_total{reason="room_state_failed"}`.
5. Check `/health/ready` for API, room-state, and remote-browser before investigating browser-only issues.

Remote-browser `/health` also reports `enabled`, `experimental`, active sessions, TTL, concurrency, and viewport limits. Relevant metrics are:

- `vrata_remote_browser_sessions_active`
- `vrata_remote_browser_sessions_started_total{result}`
- `vrata_remote_browser_sessions_stopped_total{reason}`
- `vrata_remote_browser_denied_total{reason}`
- `vrata_remote_browser_ttl_expired_total`

Do not log captured URLs, page content, cookies, frame tokens, or LiveKit tokens while investigating these metrics.
