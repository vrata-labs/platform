# План: prod-ready hardening runtime errors и observability для dev/staging

## Цель

Довести обработку runtime-сбоев для room flow до prod-ready уровня в `dev/staging`: покрыть пользовательские и системные ошибки (`mic denied`, `no audio device`, `LiveKit fail`, `room-state fail`, `XR unavailable`), добавить наблюдаемость и управляемую деградацию без breaking changes в текущих API и основном join flow.

## Не-цель

- Не менять публичные `/api/...` контракты несовместимым образом.
- Не делать production rollout; целевая среда этого плана — только `dev/staging`.
- Не перестраивать архитектуру runtime/media/state plane с нуля.
- Не внедрять полную SRE-платформу, on-call процессы или финальные production SLA.

## Предпосылки и ограничения

- Основной roadmap-пункт: `docs/plans/2026-03-25-webxr-webrtc-mvp-roadmap.md:97`.
- Зависимости и частичное покрытие соседних пунктов: `:98`, `:99`, `:101`, `:102`, `:108`.
- Основная точка входа runtime: `apps/runtime-web/src/main.ts`.
- Базовые примитивы уже есть в `apps/runtime-web/src/hardening.ts`, `apps/runtime-web/src/xr.ts`, `apps/runtime-web/src/voice.ts`, но пока это не prod-ready решение.
- Уже есть `e2e` покрытие room flow в `tests/e2e/runtime.spec.ts`; его нужно расширять, а не заменять.
- Совместимость обязательна: только обратно-совместимые изменения в manifest, diagnostics, env и UI-поведении.
- План разбит на 3+ итерации, чтобы не смешивать runtime UX, transport recovery и infra/observability в один рискованный батч.
- Источник правды для feature flags: `env` > room manifest/features > code defaults.
- Все fail-path сценарии для `e2e` и failure drills должны быть детерминированными; случайные сетевые сбои как основной механизм проверки не подходят.

## Подход

Идти в три итерации:

1. Сначала стандартизировать runtime error model, recovery UX и feature-gated degradation в браузере.
2. Затем довести transport/reconnect path и серверные сигналы здоровья до проверяемого состояния.
3. После этого подключить dev/staging observability, failure drills и manual QA, чтобы честно закрыть hardening-пункт без выхода в production.

## Задачи

### Iteration 1 - Runtime error model и UX

- [ ] Зафиксировать единый каталог runtime-ошибок и их семантику в коде и документации: `mic_denied`, `no_audio_device`, `livekit_failed`, `room_state_failed`, `xr_unavailable`, при необходимости `media_permission_blocked` и `device_not_found` как внутренние причины без API-breaking изменений.
- [ ] Расширить `apps/runtime-web/src/hardening.ts`, чтобы каждая ошибка имела: user-facing message, diagnostics note, recoverable flag, retry policy, suggested CTA.
- [ ] Вынести runtime error catalog и browser/media/XR classification в отдельный helper модуль, чтобы разгрузить `apps/runtime-web/src/main.ts`.
- [ ] Вынести маппинг browser/media ошибок в отдельный helper, чтобы `getUserMedia`/`setMicrophoneEnabled` ошибки не разбирались ad-hoc в `apps/runtime-web/src/main.ts`.
- [ ] Вынести отдельный runtime state adapter для error/degraded/recovery state transitions, чтобы UI и transport transitions не жили в одном большом файле.
- [ ] Добавить явный UI-state для recoverable/degraded/fatal сценариев без поломки текущего room shell: статусная строка, disabled/enabled controls, retry CTA, XR unavailable copy.
- [ ] Сделать graceful degradation для каждого кейса: room открывается без аудио при `mic_denied` и `no_audio_device`; room открывается без XR path при `xr_unavailable`; room остается в API fallback при `room_state_failed`, если realtime path недоступен.
- [ ] Подключить feature flags для деградации и аварийного отключения проблемных путей в `dev/staging` без изменения room contracts: отдельно для XR, audio join, room-state realtime, remote diagnostics.
- [ ] Зафиксировать и реализовать порядок разрешения feature flags: `env` override, затем manifest/features, затем code defaults.
- [ ] Обновить debug/diagnostics payload так, чтобы фиксировались error code, severity, retry count, degraded mode, last recovery action.
- [ ] Добавить unit-тесты на классификацию ошибок, retry policy, feature flag resolution и user-facing state transitions.

### Iteration 2 - Reconnect, backend health и integration hardening

- [ ] Разделить transient и terminal ошибки для `LiveKit` и `room-state`, чтобы reconnect не запускался бесконечно для заведомо невосстановимых сценариев.
- [ ] Реализовать ограниченный reconnect policy с backoff/jitter и явным ceiling для `livekit_failed` и `room_state_failed`.
- [ ] Добавить в runtime счетчики попыток, timestamp последней успешной переподписки и состояние деградации после исчерпания retries.
- [ ] Зафиксировать минимальный состав health payloads для `dev/staging`: `service`, `env`, `status`, `dependencies`, `featureFlags`, `timestamp`.
- [ ] Расширить API/room-state health payloads так, чтобы в `dev/staging` можно было видеть состояние зависимостей и включенные feature flags без breaking changes для текущих клиентов.
- [ ] Добавить structured logging для error paths в `apps/api` и `apps/room-state`: error code, roomId, participantId, transport, retry stage, environment.
- [ ] Подготовить dev/staging env matrix и значения по умолчанию для новых флагов и порогов: retry count, retry delay, diagnostics verbosity, XR toggle, media safeguards.
- [ ] Зафиксировать точки детекции LiveKit-сбоев: connect, reconnect, microphone publish, track subscribe.
- [ ] Добавить integration-тесты на fallback/reconnect сценарии: room-state disconnect, LiveKit connection failure, disabled feature flags, unavailable XR path.
- [ ] Проверить, что при отключении новых флагов поведение остается обратно-совместимым с текущим room flow и существующими `e2e` тестами.

### Iteration 3 - Dev/staging observability, failure drills и acceptance

- [ ] Описать минимальный observability contract для `dev/staging`: какие логи, health checks, diagnostics endpoints и метрики считаются обязательными для runtime/API/room-state/LiveKit.
- [ ] Зафиксировать обязательные поля structured logs/diagnostics: `service`, `env`, `roomId`, `participantId`, `errorCode`, `recoverable`, `retryCount`, `degradedMode`, `timestamp`.
- [ ] Добавить или обновить staging health checks для runtime, API, room-state и LiveKit с понятными failure signals и инструкцией, где их смотреть.
- [ ] Спроектировать схему записи staging diagnostics: поля, retention, cleanup, retrieval path.
- [ ] Реализовать retrieval path для расследования user-visible failures по roomId/participantId без ручного парсинга консоли браузера.
- [ ] Описать retention/cleanup правила для staging diagnostics, чтобы объем и шум были ограничены.
- [ ] Реализовать deterministic fault injection для `dev/test/e2e`: env flags, query params или mock endpoints для `mic_denied`, `livekit_failed`, `room_state_failed`, `xr_unavailable`, `no_audio_device`.
- [ ] Провести failure drills в `dev/staging`: mic denied, browser without mic, disabled XR, room-state restart, LiveKit недоступен, network interruption на join/after join.
- [ ] Расширить `tests/e2e/runtime.spec.ts` негативными кейсами и деградационными проверками, не ломая текущий happy path.
- [ ] Провести manual QA matrix для `desktop/mobile/VR` и зафиксировать результаты в `docs/status.md` или отдельном staging QA note.
- [ ] Подтвердить exit criteria для dev/staging: room остается usable в деградированных режимах, ошибки наблюдаемы, retries ограничены, rollback через flags/env возможен без кода.
- [ ] Обновить roadmap/status документы так, чтобы было ясно, что hardening закрыт для `dev/staging`, но production rollout остается отдельным шагом.

## Артефакты / Deliverables

- [ ] `apps/runtime-web/src/runtime-errors.ts` или эквивалентный helper с каталогом ошибок и классификацией.
- [ ] `apps/runtime-web/src/runtime-state.ts` или эквивалентный adapter для degraded/recovery transitions.
- [ ] Обновленный `apps/runtime-web/src/main.ts` с уменьшенной ответственностью и подключением новых helpers.
- [ ] `.env.example` с новыми feature flags и retry/diagnostics настройками.
- [ ] Обратно-совместимые health payloads в `apps/api` и `apps/room-state`.
- [ ] Structured logging для API и room-state error paths.
- [ ] Deterministic fault injection hooks для `dev/test/e2e`.
- [ ] Обновленные `unit`, `integration`, `e2e` тесты.
- [ ] `docs/runbooks/staging-runtime-failures.md` с шагами диагностики и rollback через flags/env.
- [ ] Обновленные `docs/status.md` и roadmap-заметки по закрытию hardening для `dev/staging`.

## Затронутые файлы/модули

- `apps/runtime-web/src/main.ts`
- `apps/runtime-web/src/hardening.ts`
- `apps/runtime-web/src/voice.ts`
- `apps/runtime-web/src/xr.ts`
- `apps/runtime-web/src/index.ts`
- `apps/runtime-web/src/*.test.ts`
- `apps/api/src/index.ts`
- `apps/room-state/src/index.ts`
- `tests/e2e/runtime.spec.ts`
- `.env.example`
- `docs/runbooks/staging-runtime-failures.md`
- `docs/status.md`
- `docs/plans/2026-03-25-webxr-webrtc-mvp-roadmap.md`
- `infra/` staging healthcheck/logging config, если в репозитории уже есть соответствующие манифесты/скрипты

## Тест-план

- **Unit**
- [ ] Классификация browser/media/XR ошибок в runtime helpers.
- [ ] Retry policy: backoff, max attempts, recoverable vs terminal branches.
- [ ] Feature flags и degraded-state resolution.
- [ ] Formatting diagnostics payload для error/recovery transitions.

- **Integration**
- [ ] Runtime + API fallback при недоступном `room-state` websocket.
- [ ] Runtime + LiveKit path при ошибке connect / publish microphone.
- [ ] Health endpoints и structured logging отдают ожидаемые поля в `dev/staging` режиме.
- [ ] Existing room flow остается рабочим без breaking changes при дефолтных env.
- [ ] Новые diagnostics/health поля остаются опциональными и не ломают существующих потребителей.

- **E2E**
- [ ] Happy path smoke: существующие сценарии остаются зелеными.
- [ ] Negative: mic denied показывает понятный статус, room остается usable без аудио.
- [ ] Negative: no audio device не валит boot и корректно логируется.
- [ ] Negative: XR unavailable скрывает/дизейблит VR path без runtime crash.
- [ ] Negative: room-state fail переводит клиента в fallback/degraded mode.
- [ ] Negative: LiveKit fail показывает recoverable/fatal state по сценарию и не ломает presence-only room.
- [ ] Все negative `e2e` используют deterministic fault injection, а не случайные сетевые сбои.

- **Manual QA / Failure drills**
- [ ] Desktop Chrome/Firefox: audio denied, reconnect, fallback, diagnostics visible.
- [ ] Mobile browser: join without mic permission, reconnect after background/foreground.
- [ ] VR headset: XR available/unavailable behavior, room usability without XR entry.
- [ ] Staging checks: health endpoints, logs, diagnostics retrieval, feature-flag rollback.

## Риски и откаты (roll-back)

- Риск: смешение UI-hardening и transport-логики приведет к хрупкому `main.ts`.
  - Откат: держать новую логику в helpers/state adapters; при проблеме отключать новый path через flags.
- Риск: reconnect логика создаст флаппинг и шум в staging.
  - Откат: ограничить retries env-порогами и быстро выключать reconnect policy флагом.
- Риск: новые diagnostics/logging дадут слишком много шума или PII.
  - Откат: staging-only verbosity, allowlist полей, возможность отключить расширенные diagnostics env-флагом.
- Риск: негативные `e2e` станут нестабильными из-за сетевой недетерминированности.
  - Откат: использовать deterministic mocks/toggles для fail-path сценариев, а не случайные сетевые сбои.
- Риск: infra-часть окажется шире текущего репозитория.
  - Откат: фиксировать gap явно в плане/документации и ограничить deliverable dev/staging-ready конфигами и runbooks внутри репозитория.

## Definition of done для этого плана

- [ ] Все целевые error scenarios имеют явную классификацию, UX и diagnostics mapping.
- [ ] Room flow остается usable хотя бы в деградированном режиме там, где это допускается.
- [ ] Reconnect/fallback политика ограничена и проверена тестами.
- [ ] `unit`, `integration`, `e2e` и staging manual QA выполнены и зафиксированы.
- [ ] В `dev/staging` доступны health checks, structured logs, diagnostics и rollback через flags/env.
- [ ] Изменения внесены без breaking changes в существующие клиентские и серверные контракты.
- [ ] Для операторов/разработчиков есть runbook: где смотреть health/logs/diagnostics и как включать rollback через flags/env.
