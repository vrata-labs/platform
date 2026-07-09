# План: WebXR/WebRTC B2B immersive room MVP (`M0 -> M1`)

## Цель

Собрать реалистичный план запуска web-native immersive room platform для компаний: сначала довести `M0` до честного многопользовательского vertical slice, затем расширить его до `M1` с шаблонами, брендингом, созданием комнат без разработчика и screen share.

## Не-цель

- Не строить собственный рендер-движок, SFU, multiparty mesh stack или universal world editor.
- Не делать VR-only продукт: desktop/mobile остаются first-class path.
- Не проектировать полноценную multi-tenant SaaS platform beyond MVP.
- Не смешивать runtime, media plane, state plane и control plane в один сервис.

## Предпосылки и ограничения

- Основа плана: `opencode-webxr-webrtc-mvp-agent (1).md`.
- Текущая директория не содержит рабочей кодовой базы; план рассчитан на greenfield-репозиторий.
- Горизонт планирования: без календарных сроков, с упором на порядок, зависимости и Definition of Done.
- Базовый стек из промта принимается как зафиксированный: `TypeScript`, `Three.js`, `WebXR`, `LiveKit`, `Colyseus`, `glTF/GLB`, Yandex Cloud.
- Для product core выбираем самый короткий путь к работающему MVP; low-level эксперименты выносятся в `research/`.

## Подход

Идти тремя эпиками, разбитыми на последовательные фазы:

1. Зафиксировать рамку продукта и подготовить инженерный каркас (`Phase 0-1`).
2. Собрать и стабилизировать `M0` как единый room flow для desktop/mobile/VR (`Phase 2-6`).
3. Достроить `M1` только теми возможностями, которые напрямую усиливают B2B use case: templates, branding, room creation, screen share, asset pipeline (`Phase 7-9`).

## Задачи

### Phase 0 - Framing и bootstrap

- [ ] Создать `docs/product-scope.md` с продуктовой гипотезой, `M0`, `M1`, non-goals и критериями успеха.
- [ ] Создать ADR для ключевых выборов: `Three.js`, `LiveKit`, `Colyseus`, desktop/mobile-first, shared managed MVP, separate research track.
- [ ] Описать общую карту слоев в `docs/architecture.md`.
- [ ] Подготовить monorepo skeleton: `apps/`, `packages/`, `research/`, `infra/`, `docs/`.
- [ ] Настроить общие скрипты `dev`, `build`, `lint`, `test`, `typecheck`.
- [ ] Настроить CI для `lint`, `typecheck`, `build`.
- [ ] Добавить `.env.example` и локальную dev-инфраструктуру для runtime/API/room-state.
- [ ] Зафиксировать `docs/status.md` с фазами и состоянием работ.

### Phase 1 - Research spikes с жестким ограничением области

- [ ] Сделать `research/webrtc-lab` для ручного signaling, `offer/answer`, ICE и TURN notes.
- [ ] Сделать `research/webxr-lab` для feature detection, session lifecycle и permission UX.
- [ ] Сделать `research/webgl-lab` для минимальной сцены и базовых performance-замеров.
- [ ] Сделать `research/audio-lab` для `AudioContext`, `PannerNode` и spatialization proof.
- [ ] Зафиксировать выводы в `docs/research/*.md` и `docs/research/conclusions.md`.
- [ ] Подтвердить ADR-решение: spikes не становятся основой product runtime.

### Phase 2 - API foundation и contracts для `M0`

- [ ] Поднять `apps/api` с базовой конфигурацией, health endpoint и structured logging.
- [ ] Описать API contracts для `room manifest`, `state token`, `LiveKit token`.
- [ ] Реализовать endpoint получения room manifest по room link.
- [ ] Реализовать endpoint выдачи state token для `Colyseus`.
- [ ] Реализовать endpoint выдачи participant token для `LiveKit`.
- [ ] Зафиксировать env matrix для local/staging и правила secret management.
- [ ] Добавить базовые CORS/origin rules и token lifetime policy для `M0`.

### Phase 3 - `M0` runtime skeleton

- [ ] Поднять `apps/runtime-web` на `TypeScript + Three.js + WebGL2`.
- [ ] Реализовать lifecycle: boot, manifest load, asset preload, mount, dispose.
- [ ] Реализовать один шаблон `meeting-room-basic` с загрузкой из manifest/config.
- [ ] Реализовать quality profiles: `mobile-lite`, `desktop-standard`, `xr`.
- [ ] Реализовать input abstraction для keyboard/mouse и touch; XR input оставить расширением следующей фазы.
- [ ] Реализовать overlay/UI для `Join Room`, `Join Audio`, `Enter VR`, connection/debug state.
- [ ] Добавить telemetry hooks и базовые client-side diagnostics.

### Phase 4 - `M0` state plane и presence

- [ ] Поднять `apps/room-state` на `Colyseus`.
- [ ] Спроектировать room schema: participant id, role, mode, transforms, mute/media flags.
- [ ] Реализовать join flow: room link -> manifest -> state token -> room join.
- [ ] Реализовать presence visualization: spherical avatars, colors, optional labels.
- [ ] Реализовать sync/interpolation и корректный cleanup при reconnect/leave.
- [ ] Отделить root transform от camera/head transform, включая XR pose path.

### Phase 5 - `M0` voice и spatial audio

- [ ] Поднять `LiveKit` в self-hosted/local режиме.
- [ ] Добавить API endpoint для participant token issuance.
- [ ] Реализовать explicit `Join Audio` UX без авто-запроса микрофона при загрузке.
- [ ] Реализовать publish/subscribe voice, mute/unmute и connection state UI.
- [ ] Реализовать spatial audio поверх remote media tracks через `AudioContext` + `PannerNode`.
- [ ] Добавить debug-переключатель между обычным voice и spatial voice.
- [ ] Завести feature flags для `spatialAudio` и remote diagnostics, чтобы можно было деградировать фичу без переписывания room flow.

### Phase 6 - `M0` WebXR и hardening

- [ ] Реализовать `navigator.xr` / `immersive-vr` feature detection.
- [ ] Показывать `Enter VR` только в поддерживаемых окружениях.
- [ ] Реализовать XR session lifecycle и pose sync в том же room flow.
- [ ] Реализовать базовое VR locomotion: smooth locomotion + snap turn.
- [ ] Добавить обработку ошибок: mic denied, no device, LiveKit fail, room-state fail, XR unavailable.
- [ ] Реализовать reconnect logic и базовую telemetry по join/audio/XR failures.
- [ ] Завести feature flag для `Enter VR`, чтобы XR path можно было отключить без отката desktop/mobile flow.
- [ ] Подготовить staging deployment в Yandex Cloud.
- [ ] Настроить health checks, error logs и базовые metrics для runtime/API/room-state/LiveKit.
- [ ] Провести manual QA и подтвердить `M0` DoD: один room link работает на desktop/mobile/VR для 2-4 участников.

### Exit criteria перед `M1`

- [ ] Заморозить API contracts и `schemaVersion` room manifest для первого product path.
- [ ] Подтвердить merge-gates для `M0`: `lint`, `typecheck`, unit для manifest/state, integration room join flow.
- [ ] Подтвердить, что staging room flow стабилен без обязательного XR path.

### Phase 7 - `M1` данные, совместимость и control-plane backend

- [ ] Выбрать persistent storage для `tenant`, `template`, `space`, `room`, `asset`.
- [ ] Описать схему данных и миграции для control-plane сущностей.
- [ ] Зафиксировать правило backward compatibility между runtime, manifest и API.
- [ ] Формализовать `schemaVersion` для `space/room manifest` и политику эволюции схемы.
- [ ] Реализовать backend CRUD для `tenant`.
- [ ] Реализовать backend CRUD для `template`.
- [ ] Реализовать backend CRUD для `room/space`.
- [ ] Реализовать backend metadata flow для `asset`.
- [ ] Реализовать manifest generation и room link issuance.

### Phase 8 - `M1` templates и control plane UI

- [ ] Спроектировать `space.manifest.json` и template registry.
- [ ] Вынести scene-specific config из runtime core.
- [ ] Подготовить 2-3 templates: `meeting-room`, `showroom`, `event-demo-room`.
- [ ] Добавить asset slots и theme/branding tokens.
- [ ] Создать страницу списка rooms в `apps/control-plane`.
- [ ] Создать форму `create room` с выбором template.
- [ ] Подключить загрузку бренд-ассетов для logo/background/media slots.
- [ ] Показать generated room link и статус публикации.
- [ ] Проверить, что branded room создается без ручной правки кода.

### Phase 9 - `M1` collaboration features и production hardening

- [ ] Реализовать screen share publish flow для host.
- [ ] Реализовать media surfaces в runtime и привязку stream к surface/plane.
- [ ] Добавить host controls: start/stop share, pin/unpin.
- [ ] Добавить feature flag для `screenShare`, чтобы отключать фичу без rollback схемы.
- [ ] Добавить `glTF` validator CLI в asset pipeline.
- [ ] Добавить CI job для `glTF` validation и content constraints.
- [ ] Добавить preset для texture conversion.
- [ ] Добавить preset для mesh compression.
- [ ] Добавить quality budgets и budget checks.
- [ ] Подготовить security baseline: HTTPS/WSS, permissions UX, session tokens, structured logging, abuse basics.
- [ ] Подготовить shared managed deployment flow для `M1` с env segregation, secret handling и backup policy для control-plane данных.
- [ ] Настроить merge-gates для `M1`: плюс CRUD integration, asset validation CI, screen share integration.
- [ ] Подтвердить `M1` DoD: branded room создается без разработчика, voice и screen share стабильны, runtime остается layer-separated.

## Затронутые файлы/модули

Если следовать исходному промту, основными точками входа станут:

- `docs/product-scope.md`
- `docs/architecture.md`
- `docs/status.md`
- `docs/research/`
- `docs/adr/`
- `apps/runtime-web/`
- `apps/api/`
- `apps/room-state/`
- `apps/control-plane/`
- `packages/runtime-core/`
- `packages/shared-types/`
- `packages/templates/`
- `packages/asset-pipeline/`
- `research/`
- `infra/`

## Данные и совместимость

- `room manifest` и `space manifest` должны иметь явный `schemaVersion`.
- Любое изменение manifest/API contracts должно сопровождаться правилом backward compatibility или явным migration step.
- Для control plane нужен отдельный persistent storage и версия схемы данных.
- Миграции должны быть воспроизводимыми для local и staging окружений.
- Runtime не должен зависеть от неверсированного формата данных из control plane.

## Тест-план

### Unit

- Проверить manifest parsing, schema validation и feature-flag resolution.
- Проверить room/state serializers, role/policy checks, token issuance helpers.
- Проверить quality-profile selection и fallback logic.
- Проверить asset-pipeline validators и budget rules.

### Integration

- Проверить flow `room link -> manifest -> token -> Colyseus join -> LiveKit join`.
- Проверить синхронизацию presence/transforms между 2-4 участниками.
- Проверить publish/subscribe audio и reconnect после сетевого разрыва.
- Проверить control-plane flow: create tenant -> create room -> generate manifest -> open runtime link.
- Проверить screen share attach/detach к media surface.
- Проверить backward compatibility manifest после неразрушающего изменения схемы.

### E2E

- Desktop Chrome: вход в комнату, движение, voice, reconnect.
- Mobile browser: вход в ту же комнату, 3D fallback, voice join.
- Quest/совместимый XR browser: вход по тому же link, `Enter VR`, базовое перемещение.
- Admin flow: создать branded room и открыть ее без ручной правки кода.

### Негативные кейсы

- Микрофон запрещен или отсутствует.
- `navigator.xr` недоступен или `immersive-vr` unsupported.
- LiveKit недоступен, token invalid, Colyseus room full/unreachable.
- Битый или неполный room manifest.
- Невалидный `glTF`/слишком тяжелые assets.
- Screen capture запрещен браузером или отменен пользователем.
- Несовместимая версия manifest/API contract.

### CI / merge gates

- Для `M0` обязательны: `lint`, `typecheck`, unit для manifest/state helpers, integration для room join flow.
- Для `M1` обязательны: все проверки `M0` плюс CRUD integration, asset validation CI и screen share integration.
- E2E для XR можно запускать вне merge-gate, но manual QA для staging обязателен перед demo/release.

## Риски и откаты

- Риск: research spikes начинают разрастаться и тормозить delivery. Откат: freeze spikes после фиксации выводов, все новые идеи только через ADR.
- Риск: runtime и control plane начнут смешиваться. Откат: отдельные apps/packages и API contracts до добавления новых фич.
- Риск: нестабильность voice/WebXR на ранних девайсах. Откат: desktop/mobile path и обычный voice остаются основным demo path; XR и spatial audio можно временно деградировать до optional features.
- Риск: asset quality ломает performance. Откат: жесткие budgets, quality profiles и fallback assets `lite`.
- Риск: `M1` разрастается в platform-building. Откат: stop-list на custom SFU, editor, plugin marketplace и per-tenant infra.
- Риск: поломка совместимости между runtime и manifest/API. Откат: versioned contracts, migration steps и feature-flag rollout.

## Критерии завершения плана

- `M0` считается завершенным только после публичного staging room flow на desktop/mobile/VR.
- `M1` считается завершенным только после self-service создания branded room без разработчика.
- Любая задача, не усиливающая эти два результата, считается вторичной и может быть отложена.
