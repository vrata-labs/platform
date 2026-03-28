# Staging Runtime Failures

## Purpose

This runbook explains how to diagnose and mitigate room runtime failures in `dev/staging` without changing code.

## Scope

- Runtime/browser room flow
- API health and diagnostics
- Room-state websocket path
- LiveKit availability for audio
- XR availability and feature gating

## Quick checks

1. Open staging API health: `https://epdl1gel4vp4l6hju9rk.51.250.19.248.sslip.io/health`
2. Confirm `status: ok` and inspect:
   - `features.xrEnabled`
   - `features.voiceEnabled`
   - `features.screenShareEnabled`
   - `features.roomStateRealtimeEnabled`
   - `features.remoteDiagnosticsEnabled`
   - `dependencies.livekit`
   - `dependencies.roomStatePublicUrl`
3. Open room-state health: `http://127.0.0.1:2567/health` locally or the staging room-state endpoint if exposed.
4. Load a room with `?debug=1` and inspect `window.__NOAH_DEBUG__`.

## Main signals

- `status-line` in the room UI
- `room-state-line` in the room UI
- `window.__NOAH_DEBUG__`
- `POST /api/rooms/:roomId/diagnostics` records
- JSON logs from `apps/api`
- JSON logs from `apps/room-state`

## Debug fields to inspect

- `issueCode`
- `issueSeverity`
- `degradedMode`
- `retryCount`
- `lastRecoveryAction`
- `audioState`
- `roomStateMode`
- `featureFlags`
- `faultInjection`

## Failure map

### `mic_denied`

Symptoms:
- UI shows `Microphone blocked; room continues without audio`
- `issueCode=mic_denied`
- `degradedMode=audio_unavailable`

Checks:
1. Verify browser permission state for microphone.
2. Retry with explicit user gesture on `Join Audio`.
3. Confirm room remains usable for presence/movement.

Mitigation:
- Tell QA to allow microphone and retry.
- If voice path is unstable globally, disable with `FEATURE_VOICE=false`.

### `no_audio_device`

Symptoms:
- UI shows `No microphone found; room continues without audio`
- `issueCode=no_audio_device`

Checks:
1. Confirm browser/device has an input device.
2. Re-test with a connected headset or laptop mic.

Mitigation:
- Continue room validation without audio.
- Disable voice temporarily with `FEATURE_VOICE=false` if it blocks QA.

### `livekit_failed`

Symptoms:
- UI shows `Audio service unavailable; room continues in presence-only mode`
- `issueCode=livekit_failed`
- diagnostics note contains `livekit_failed`

Checks:
1. Confirm `dependencies.livekit` from `/health`.
2. Verify `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` in env.
3. Check API logs for token or connection errors.

Mitigation:
- Set `FEATURE_VOICE=false` to keep room flow usable without audio.
- Keep `FEATURE_ROOM_STATE_REALTIME=true` if presence path is healthy.

### `room_state_failed`

Symptoms:
- `room-state-line` shows `Room-state: fallback API`
- `issueCode=room_state_failed`
- `degradedMode=api_fallback`
- `retryCount` increases until retries are exhausted

Checks:
1. Confirm room-state `/health` responds.
2. Check websocket reachability to `ROOM_STATE_PUBLIC_URL`.
3. Inspect room-state logs for `socket_error`.

Mitigation:
- Leave runtime in API fallback if room remains usable.
- Disable realtime path with `FEATURE_ROOM_STATE_REALTIME=false` if websocket path is unstable.

### `xr_unavailable`

Symptoms:
- VR button disabled with `VR unavailable`
- `issueCode=xr_unavailable`
- `degradedMode=xr_disabled`

Checks:
1. Confirm browser/device supports `navigator.xr`.
2. Verify `FEATURE_XR` is not `false`.
3. Re-test on supported headset/browser.

Mitigation:
- Continue validation on desktop/mobile.
- Disable XR intentionally with `FEATURE_XR=false` if the path is noisy.

## Deterministic fault injection

Use only in `dev/test/staging` verification:

- `?failaudio=mic_denied`
- `?failaudio=no_audio_device`
- `?failaudio=livekit_failed`
- `?failroomstate=1`
- `?failxr=1`
- `?debug=1`

Examples:

```text
/rooms/demo-room?debug=1&failaudio=mic_denied
/rooms/demo-room?debug=1&failroomstate=1
/rooms/demo-room?debug=1&failxr=1
```

## Rollback via flags

Use env flags before code rollback:

- `FEATURE_XR=false`
- `FEATURE_VOICE=false`
- `FEATURE_SCREEN_SHARE=false`
- `FEATURE_ROOM_STATE_REALTIME=false`
- `FEATURE_REMOTE_DIAGNOSTICS=false`

Recommended order:
1. Disable the failing feature only.
2. Re-check `/health`.
3. Re-run one room smoke test.
4. Confirm room remains usable in degraded mode.

## Minimal smoke test after mitigation

1. Open `/rooms/demo-room?debug=1`
2. Confirm room shell loads.
3. Confirm presence still appears.
4. Confirm `status-line` and `room-state-line` match expected degraded state.
5. Confirm a diagnostics record is created.

## Where to look in code

- `apps/runtime-web/src/main.ts`
- `apps/runtime-web/src/runtime-errors.ts`
- `apps/runtime-web/src/runtime-state.ts`
- `apps/runtime-web/src/reconnect.ts`
- `apps/api/src/index.ts`
- `apps/room-state/src/index.ts`
- `tests/e2e/runtime.spec.ts`

## Escalate when

- Room is not usable even in degraded mode.
- `retryCount` is exhausted and fallback still does not work.
- `/health` is unhealthy or missing required fields.
- Diagnostics are missing while `FEATURE_REMOTE_DIAGNOSTICS=true`.
