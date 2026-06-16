# Staging migration 2026-03-30

## Hosts

- Legacy API host: `<legacy-api-host>`
- Previous scenes host: `<previous-scenes-host>`
- New scenes host: `<new-scenes-host>`

## Preserved room inventory

- Source inventory was copied from `<previous-scenes-host>/api/rooms`.
- `24` scene rooms were recreated on the new host with the same `roomId` values.
- `sceneBundleUrl` values were patched onto the recreated rooms after import.
- `demo-room` remained present on the new host.

## Verified on the new host

- `GET /health` returns `status=ok`.
- Runtime HUD includes the new `#space-select` selector.
- `GET /api/rooms/demo-room/spaces` returns the imported room list.
- Staging smoke passes with selector navigation:
  - `demo-room`
  - `8115f026-dd32-435a-a606-943d0f4af696` (`Sense Hall Clean GLB Screen v15`)
- Control-plane page loads at `/control-plane`.
- Admin room CRUD works with `x-noah-admin-token: noah-stage-admin`.
- Presence API updates while a room page is open.
- Key scene rooms load with `sceneBundleState=loaded`:
  - `8115f026-dd32-435a-a606-943d0f4af696` (`SenseTower Hall`)
  - `73c6863a-f236-4aee-8da6-9449211fd3de` (`Sense BlueOffice`)

## Notes

- The old host in `docs/status.md` was stale; TLS on `51.250.19.248` is broken.
- The fresh VM path remains safer than patching old staging in place.
- Scene room preservation currently relies on API-level export/import, not DB snapshot restore.
