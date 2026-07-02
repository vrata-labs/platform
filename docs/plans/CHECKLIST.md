# VRATA feature backlog — чеклист

Этот файл — корневой список всех формализованных фич и их расположения в архиве. Отмечайте пункты по мере создания issue/PR и прохождения acceptance criteria.

## Сводка

- **P0:** 13 пунктов
- **P1:** 15 пунктов
- **P2:** 7 пунктов
- **P3:** 3 пунктов
- **Всего:** 38 пунктов

## P0

- [x] **VRATA-FEAT-001** — [Production-safe self-host profile](./001-production-safe-self-host-profile/README.md)
- [x] **VRATA-FEAT-002** — [AuthN/AuthZ для control-plane actions](./002-control-plane-authn-authz/README.md) — зависит от: 003
- [x] **VRATA-FEAT-003** — [Signed room/session tokens](./003-signed-room-session-tokens/README.md) — зависит от: 001
- [x] **VRATA-FEAT-004** — [Real LiveKit SDK voice integration](./004-real-livekit-sdk-voice-integration/README.md) — зависит от: 003, 011
- [x] **VRATA-FEAT-005** — [Mute/unmute lifecycle + synced media state](./005-mute-unmute-lifecycle-synced-media-state/README.md) — зависит от: 004
- [x] **VRATA-FEAT-006** — [Spatial audio graph](./006-spatial-audio-graph/README.md) — зависит от: 004, 005
- [x] **VRATA-FEAT-007** — [Reliable 2–4 participant room scenario](./007-reliable-2-4-participant-room-scenario/README.md) — зависит от: 003, 004, 005
- [x] **VRATA-FEAT-008** — [Cross-device join flow: desktop, mobile, VR](./008-cross-device-join-flow-desktop-mobile-vr/README.md) — зависит от: 007
- [x] **VRATA-FEAT-009** — [WebXR renderer wiring](./009-webxr-renderer-wiring/README.md) — зависит от: 008
- [x] **VRATA-FEAT-010** — [Public connectivity diagnostics](./010-public-connectivity-diagnostics/README.md) — зависит от: 001, 011
- [x] **VRATA-FEAT-011** — [TURN/TLS-ready LiveKit deployment profile](./011-turn-tls-livekit-deployment-profile/README.md) — зависит от: 001, 004
- [x] **VRATA-FEAT-012** — [Observability baseline](./012-observability-baseline/README.md) — зависит от: 001
- [x] **VRATA-FEAT-013** — [Backup/restore/rollback automation](./013-backup-restore-rollback-automation/README.md) — зависит от: 001, 012

## P1

- [x] **VRATA-FEAT-014** — [Private room access mode](./014-private-room-access-mode/README.md) — зависит от: 002, 003
- [x] **VRATA-FEAT-015** — [Host controls for small meetings](./015-host-controls-for-small-meetings/README.md) — зависит от: 002, 014
- [ ] **VRATA-FEAT-016** — [Room creation UI without developer](./016-room-creation-ui-without-developer/README.md) — зависит от: 002, 014, 017
- [ ] **VRATA-FEAT-017** — [Scene bundle upload UI](./017-scene-bundle-upload-ui/README.md) — зависит от: 002, 018
- [x] **VRATA-FEAT-018** — [Scene bundle validator CLI](./018-scene-bundle-validator-cli/README.md)
- [ ] **VRATA-FEAT-019** — [Personal room mode](./019-personal-room-mode/README.md) — зависит от: 014, 020, 022
- [ ] **VRATA-FEAT-020** — [Persistent notes panel](./020-persistent-notes-panel/README.md) — зависит от: 002, 014
- [ ] **VRATA-FEAT-021** — [Markdown board / sticky notes surface](./021-markdown-board-sticky-notes-surface/README.md) — зависит от: 020, 007
- [ ] **VRATA-FEAT-022** — [Documents library for room](./022-documents-library-for-room/README.md) — зависит от: 002, 014
- [ ] **VRATA-FEAT-023** — [Notes history and export](./023-notes-history-and-export/README.md) — зависит от: 020, 021
- [ ] **VRATA-FEAT-024** — [Screen share as in-room media surface](./024-screen-share-as-in-room-media-surface/README.md) — зависит от: 004, 026
- [ ] **VRATA-FEAT-025** — [PDF/slides presentation surface](./025-pdf-slides-presentation-surface/README.md) — зависит от: 022, 026
- [ ] **VRATA-FEAT-026** — [Presenter role and presentation permissions](./026-presenter-role-and-presentation-permissions/README.md) — зависит от: 002, 015
- [ ] **VRATA-FEAT-027** — [Image/video media surfaces](./027-image-video-media-surfaces/README.md) — зависит от: 022, 026
- [ ] **VRATA-FEAT-028** — [Remote browser hardening or explicit experimental flag](./028-remote-browser-hardening-or-explicit-experimental-flag/README.md) — зависит от: 001, 002

## P2

- [ ] **VRATA-FEAT-029** — [Compatibility matrix page](./029-compatibility-matrix-page/README.md) — зависит от: 008, 009, 034
- [ ] **VRATA-FEAT-030** — [Guest onboarding and permissions UX](./030-guest-onboarding-and-permissions-ux/README.md) — зависит от: 014, 008, 004
- [ ] **VRATA-FEAT-031** — [Admin dashboard for tenant rooms/assets/users](./031-admin-dashboard-for-tenant-rooms-assets-users/README.md) — зависит от: 002, 016, 017
- [ ] **VRATA-FEAT-032** — [Standard room templates: personal, meeting, presentation](./032-standard-room-templates-personal-meeting-presentation/README.md) — зависит от: 016, 019, 024, 025
- [ ] **VRATA-FEAT-033** — [Public demo scenario: one private room, four participants, slides, notes](./033-public-demo-scenario-one-private-room-four-participants-slides-notes/README.md) — зависит от: 007, 014, 020, 025, 015
- [ ] **VRATA-FEAT-034** — [Release readiness checklist with product gates](./034-release-readiness-checklist-with-product-gates/README.md) — зависит от: 007, 029, 035
- [ ] **VRATA-FEAT-035** — [Known limitations UI/docs alignment](./035-known-limitations-ui-docs-alignment/README.md) — зависит от: 028, 029, 034

## P3

- [ ] **VRATA-FEAT-036** — [Meeting recording](./036-meeting-recording/README.md) — зависит от: 004, 024, 022
- [ ] **VRATA-FEAT-037** — [Meeting notes export / summary artifact](./037-meeting-notes-export-summary-artifact/README.md) — зависит от: 020, 021, 023, 025
- [ ] **VRATA-FEAT-038** — [Plugin/API boundary for collaboration surfaces](./038-plugin-api-boundary-for-collaboration-surfaces/README.md) — зависит от: 020, 021, 025

## Рекомендуемые последовательности работ

### Спринт 1 — доверенный публичный self-host
- [x] VRATA-FEAT-001
- [x] VRATA-FEAT-002
- [x] VRATA-FEAT-003
- [x] VRATA-FEAT-010
- [x] VRATA-FEAT-011
- [x] VRATA-FEAT-012
- [x] VRATA-FEAT-013

### Спринт 2 — реальная малая встреча
- [x] VRATA-FEAT-004
- [x] VRATA-FEAT-005
- [x] VRATA-FEAT-006
- [x] VRATA-FEAT-007
- [x] VRATA-FEAT-008
- [x] VRATA-FEAT-009

### Спринт 3 — управляемые комнаты
- [x] VRATA-FEAT-014
- [x] VRATA-FEAT-015
- [ ] VRATA-FEAT-016
- [ ] VRATA-FEAT-017
- [x] VRATA-FEAT-018
- [ ] VRATA-FEAT-030
- [ ] VRATA-FEAT-031

### Спринт 4 — личное пространство
- [ ] VRATA-FEAT-019
- [ ] VRATA-FEAT-020
- [ ] VRATA-FEAT-021
- [ ] VRATA-FEAT-022
- [ ] VRATA-FEAT-023

### Спринт 5 — презентации
- [ ] VRATA-FEAT-024
- [ ] VRATA-FEAT-025
- [ ] VRATA-FEAT-026
- [ ] VRATA-FEAT-027
- [ ] VRATA-FEAT-028

### Спринт 6 — зрелость и публичное доверие
- [ ] VRATA-FEAT-029
- [ ] VRATA-FEAT-032
- [ ] VRATA-FEAT-033
- [ ] VRATA-FEAT-034
- [ ] VRATA-FEAT-035
- [ ] VRATA-FEAT-036
- [ ] VRATA-FEAT-037
- [ ] VRATA-FEAT-038

## Проверка готовности конкретной фичи

- [ ] Создан GitHub Issue из соответствующего `README.md`.
- [ ] Уточнены фактические пути в репозитории.
- [ ] Зафиксированы API/contracts/events.
- [ ] Реализован код.
- [ ] Пройдены unit/integration/e2e/manual тесты по ТЗ.
- [ ] Обновлены docs, diagnostics, metrics и changelog при необходимости.
- [ ] Все acceptance criteria закрыты.
