# План: Phase 2 — remote avatars и pose sync `v1`

Статус: DONE (2026-04-04)

## Итог

Phase 2 доведена до рабочего staging-ready состояния. Реализованы reliable avatar state relay/replay, transient pose relay, participant-scoped pose buffers, adaptive playback delay, reconnect/late join recovery, same-browser tab identity separation, secure scene selector links и default-on avatar path для комнат. По финальному ручному прогону закрыты основные продуктовые регрессии Phase 2: взаимная видимость web/web и web/VR, сохранение `Enter VR` после scene switching, корректная загрузка avatar path в тяжёлых scene rooms, XR entry pitch reset, movement direction alignment по взгляду и видимость remote VR hands на web-наблюдателе.

## Ключевые финальные изменения

- `apps/room-state/src/index.ts`: relay для `avatar_reliable_state` и `avatar_pose_preview`, late-join replay reliable state, validation и server-side participant identity enforcement.
- `apps/runtime-web/src/main.ts`: ранний boot `room-state` и local avatar до тяжёлой scene load, adaptive pose send rate, reconnect republish, XR entry pitch reset, movement alignment по camera forward, per-tab participant identity.
- `apps/runtime-web/src/avatar/avatar-pose-buffer.ts`: pose ring buffer, stale/reorder drop, adaptive playback delay `100-140 ms`.
- `apps/runtime-web/src/avatar/remote-avatar-runtime.ts`: buffered remote pose ingest, interpolation/smoothing, reconnect-safe participant models, fallback handling и VR hand visibility fallback на web.
- `apps/runtime-web/src/avatar/avatar-snapshot-codec.ts`: world-space serialization для head/hands.
- `apps/runtime-web/src/avatar/avatar-xr-input.ts`: корректный выбор активной пары XR axes.
- `apps/api/src/index.ts` и `infra/docker/compose.staging.yml`: secure staging space links и default-on avatar/pose feature path.
- `apps/api/src/storage.ts`, `packages/runtime-core/src/flags.ts`, `apps/runtime-web/src/avatar/avatar-runtime.ts`: avatars enabled by default.

## Цель

Довести существующий avatar transport/stub path до рабочего `v1` для multiplayer: reliable avatar state, transient pose sync, буферы, интерполяция, reconnect/late join и безопасный fallback к coarse remote presence без дубликатов и сломанного состояния.

## Не-цель

- Не делать full remote mesh polish и не превращать эту фазу в финальный visual avatar pass.
- Не делать lipsync, seating, leg polish, foot planting и rich hand-tracking transport.
- Не переводить avatar realtime на отдельный media/data channel; Phase 2 остаётся на `room-state`.
- Не переписывать локальный self-avatar pipeline из Phase 1, кроме точек интеграции для publish/ingest.
- Не расширять scope до кастомизации профиля, persisted avatar profile или нового backend-хранилища.

## Предпосылки и ограничения

- В roadmap Phase 2 уже зафиксирована как `Remote avatars и pose sync v1` в `docs/2026-04-01-noah-avatar-system-tz-roadmap.md:1259`; реалистичная граница фазы — transport/sync и рабочий remote runtime, а не финальный visual polish.
- После Phase 1 в `apps/runtime-web/src/avatar/*` уже есть локальный controller, snapshot contract, reliable state parser, pose-frame parser/publisher и `remote-avatar-runtime` stub.
- В `apps/runtime-web/src/room-state-client.ts` уже есть клиентские сообщения `avatar_reliable_state` и `avatar_pose_preview`, но `apps/room-state/src/index.ts` пока их не ретранслирует.
- Текущий `remote-avatar-runtime` уже умеет ingest reliable state и pose frame, хранит debug state и рисует stub body/head/hands; значит Phase 2 должна эволюционно улучшать этот путь.
- В репозитории уже есть coarse presence sync и interpolation через `motion-state.ts`; не нужно дублировать этот слой там, где можно переиспользовать существующие паттерны.
- Обязательный крайний случай: при сбое avatar realtime path runtime должен вернуться к coarse capsule/presence behavior без поломки room flow.
- Проверка завершения фазы должна включать не только локальные тесты, но и staging deploy + `pnpm test:e2e:staging`.
- Для этой фазы нужно явно зафиксировать feature flag/config entrypoint, который включает remote avatar realtime path и позволяет быстро откатиться к coarse presence path.
- Нужно заранее выбрать единую стратегию late join: либо `room-state` хранит последний reliable avatar state per participant, либо клиент обязан перепубликовать reliable state при connect/reconnect.

## Подход

Оставить Phase 1 self-avatar как источник локального authoritative snapshot, поверх него ввести компактный publish/relay/ingest pipeline через `room-state`, затем стабилизировать remote jitter handling в runtime: seq ordering, ring buffer, interpolation window, короткая extrapolation и cleanup на reconnect/disconnect. В этой фазе renderer для remote участников остаётся существующим stub/capsule-friendly runtime с корректным `avatarId`/input-mode state и плавным head/hands/root sync; полноценный remote mesh/render polish выносится дальше.

## Definition of Done

Фаза завершена, если:

1. Два и более клиента видят друг у друга `head/hands/root` в реальном времени.
2. Remote avatars двигаются плавно на стабильной сети без stop-motion применения последнего пакета.
3. `avatarId` и `inputMode` корректно восстанавливаются при late join.
4. Stale/out-of-order pose frames дропаются без поломки последнего валидного состояния.
5. При reconnect не остаётся duplicate remote avatar для одного `participantId`.
6. При выключении avatar realtime path runtime возвращается к coarse remote presence/capsule behavior.

## Задачи (чек-лист)

### 1. Зафиксировать transport contract Phase 2

- [x] Подтвердить один authoritative reliable contract для `avatarId`, `inputMode`, `seated`, `seatId`, `muted`, `audioActive`, `updatedAt` на базе `apps/runtime-web/src/avatar/avatar-types.ts`.
- [x] Подтвердить один transient contract для `CompactPoseFrame`: `seq`, `sentAtMs`, `root`, `head`, `leftHand`, `rightHand`, `locomotion`.
- [x] Явно отделить reliable path от transient path по частоте и семантике, чтобы reconnect/late join не зависели от pose stream.
- [x] Зафиксировать правило совместимости: при отключённом realtime pose runtime продолжает показывать coarse remote presence без краша.

### 2. Доработать relay в `room-state`

- [x] Расширить `apps/room-state/src/index.ts`, чтобы сервис принимал и ретранслировал `avatar_reliable_state` всем участникам комнаты.
- [x] Расширить `apps/room-state/src/index.ts`, чтобы сервис принимал и ретранслировал `avatar_pose_preview` всем участникам комнаты.
- [x] Не смешивать avatar relay с сериализацией `room_state`; snapshot комнаты остаётся отдельным сообщением.
- [x] Гарантировать, что participant identity для relay берётся с серверной стороны, а не доверяется клиентскому payload целиком.
- [x] Добавить защиту от невалидных payload и логирование дропа без падения room-state процесса.
- [x] Зафиксировать и реализовать стратегию late join для reliable state: хранение последнего reliable avatar state на сервере или обязательный republish при connect/reconnect.

### 3. Собрать runtime publish path

- [x] Подключить publish reliable state из локального avatar snapshot в обычном room flow, а не только в debug preview.
- [x] Подключить периодическую отправку pose frame с baseline-частотой: VR `30 Hz`, desktop/mobile `10 Hz`, с документированным throttling/degrade path; для VR degrade floor не опускать ниже `20 Hz`.
- [x] Не отправлять лишние pose updates, если локальный avatar выключен, room-state не подключён или avatar realtime path отключён feature flag.
- [x] Зафиксировать измеряемые debug counters: send rate, last seq, last sent timestamp, dropped-send reason.

### 4. Собрать runtime ingest path для remote участников

- [x] Подключить входящие `avatar_reliable_state` и `avatar_pose_preview` из `apps/runtime-web/src/room-state-client.ts` к `remote-avatar-runtime`.
- [x] Ввести participant-scoped remote avatar model с раздельным хранением presence, reliable state и transient pose stream.
- [x] На late join корректно поднимать remote participant даже если reliable state пришёл раньше pose frame или наоборот.
- [x] При disconnect/reconnect очищать старое remote avatar state по `participantId`, чтобы не возникали duplicate remote avatars.

### 5. Добавить ring buffer и ordering rules

- [x] Добавить отдельный модуль буфера pose frames per participant, например `apps/runtime-web/src/avatar/avatar-pose-buffer.ts`.
- [x] Дропать устаревшие и out-of-order frames по `seq` без поломки последнего валидного состояния.
- [x] Ограничить размер ring buffer и TTL старых frame entries, чтобы remote sync не накапливал лишнюю память.
- [x] Зафиксировать отдельные debug метрики: last seq, dropped stale count, dropped reorder count, buffer depth.

### 6. Реализовать interpolation/extrapolation для remote pose

- [x] Перевести `remote-avatar-runtime` с ad-hoc применения последнего frame на чтение из pose buffer.
- [x] Ввести interpolation window для head/hands/root и короткую bounded extrapolation только как fallback на коротких разрывах.
- [x] Ограничить extrapolation по времени и скорости, чтобы при сетевых провалах не появлялись телепорты и сломы позы.
- [x] Зафиксировать приоритет fallback-источников для remote root/head: pose buffer -> coarse presence snapshot -> stub default.
- [x] Зафиксировать deterministic fallback: если buffer пуст или слишком старый, remote avatar возвращается к coarse presence/stub state.

### 7. Довести remote renderer до Phase 2 scope

- [x] Оставить renderer на существующем remote stub path, но синхронизировать `avatarId`, input mode, hand visibility и locomotion debug state.
- [x] Убедиться, что body/head/hands обновляются из remote pose path плавно, а не через stop-motion применение последнего пакета.
- [x] Сохранить безопасный capsule/stub fallback, если reliable state или pose stream сломаны.
- [x] Не начинать в этой фазе полноценный remote mesh/avatar-instance render pass.

### 8. Закрыть reconnect, late join и cleanup

- [x] Поздно вошедший клиент получает корректный `avatarId` и поднимает remote stub без ожидания полного переподключения комнаты.
- [x] После reconnect того же участника старый remote entity удаляется и заменяется новым без дубля в сцене.
- [x] При временном отсутствии pose stream reliable state остаётся валидным, а renderer деградирует предсказуемо.
- [x] При полном отключении avatar realtime feature flag runtime возвращается к coarse remote presence path.

### 9. Документация и выпуск фазы

- [x] Обновить документацию по avatar transport/contracts и явно описать границу между reliable state, pose stream и coarse presence.
- [x] Зафиксировать measured packet size, send rate и jitter/debug counters как артефакты выхода фазы.
- [x] Подготовить staging smoke room/feature-flag path для проверки нескольких клиентов.

## Затронутые файлы/модули (если известно)

- `docs/2026-04-01-noah-avatar-system-tz-roadmap.md`
- `docs/plans/2026-04-02-phase-1-local-self-avatar-body-solve.md`
- `docs/plans/2026-04-03-phase-2-remote-avatar-pose-sync-v1.md`
- `apps/room-state/src/index.ts`
- `apps/runtime-web/src/main.ts`
- `apps/runtime-web/src/room-state-client.ts`
- `apps/runtime-web/src/motion-state.ts`
- `apps/runtime-web/src/avatar/avatar-types.ts`
- `apps/runtime-web/src/avatar/avatar-reliable-state.ts`
- `apps/runtime-web/src/avatar/avatar-pose-frame.ts`
- `apps/runtime-web/src/avatar/avatar-publish.ts`
- `apps/runtime-web/src/avatar/remote-avatar-runtime.ts`
- `apps/runtime-web/src/avatar/avatar-pose-buffer.ts` (новый)
- `apps/runtime-web/src/avatar/avatar-transport.ts` (новый или соседний helper, если publish/ingest wiring будет вынесен из `main.ts`)
- `apps/runtime-web/src/avatar/*.test.ts` новые и существующие тесты для codec/buffer/order/interpolation/reconnect
- `apps/runtime-web/src/room-state-client.test.ts`
- `apps/room-state/src/*.test.ts`

## Тест-план

- **Unit**
- [ ] Тесты на encode/decode reliable state и pose frame без потери обязательных полей.
- [ ] Тесты на `seq` ordering: новый frame принимается, stale/out-of-order frame дропается.
- [ ] Тесты на ring buffer: ограничение размера, TTL cleanup, корректный выбор соседних samples.
- [ ] Тесты на interpolation/extrapolation clamps для head/hands/root.
- [ ] Тесты на fallback при пустом/сломанный buffer или невалидном payload.

- **Integration**
- [ ] Проверка, что `room-state` принимает и ретранслирует `avatar_reliable_state` и `avatar_pose_preview` независимо от `room_state` snapshot.
- [ ] Проверка пути `local snapshot -> publish -> room-state relay -> remote ingest -> remote runtime update` между двумя клиентами.
- [ ] Проверка late join: новый клиент видит уже подключённого участника с корректным `avatarId` и валидным remote state.
- [ ] Проверка reconnect: после переподключения не остаётся duplicate remote avatar для того же `participantId`.
- [ ] Проверка деградации: при отключении/reject realtime pose remote path откатывается в coarse presence/stub behavior.
- [ ] Проверка искусственного jitter / packet delay / packet reordering на уровне тестового transport harness.

- **E2E / smoke**
- [ ] Добавить или расширить e2e-сценарий минимум на 2 клиента с проверкой, что head/hands/root меняются у remote участника.
- [ ] Прогнать локально обязательный набор: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm test:e2e`.
- [ ] После внедрения выкатить изменения на staging и прогнать `pnpm test:e2e:staging`.
- [ ] На staging проверить минимум 2 клиента в одной комнате и зафиксировать, что remote path не ломает существующий room load.

- **Manual**
- [ ] Два desktop клиента: движение, повороты, быстрые движения руками, проверка плавности remote sync.
- [ ] Desktop + Quest/WebXR: убедиться, что remote VR руки и голова выглядят согласованно и не дёргаются на стабильной сети.
- [ ] Для VR near-avatar case отдельно проверить быстрые жесты руками и повороты головы на комфортность и отсутствие ощущения "вязкого" remote motion.
- [ ] Проверить reconnect одного клиента без дубликатов remote entity.

- **Негативные кейсы**
- [ ] Приходят stale pose frames с меньшим `seq`: remote avatar продолжает жить на последнем валидном состоянии.
- [ ] Приходит reliable state без pose stream: remote participant виден в coarse/stub режиме без краша.
- [ ] Приходит pose stream без уже загруженного visual state: runtime не падает и поднимает participant после следующего валидного состояния.
- [ ] Room-state relay получает невалидный avatar payload: сообщение дропается, процесс не падает.
- [ ] Realtime avatar feature flag выключается во время session: runtime очищает pose pipeline и возвращается к coarse remote presence.

## Финальная верификация

- Локально прогнаны `pnpm test` и `pnpm test:e2e` на финальном состоянии Phase 2.
- Public staging прогнан через `BASE_URL="https://89.169.161.91.sslip.io" PLAYWRIGHT_NO_WEB_SERVER=1 pnpm test:e2e:staging`; финальный расширенный suite зелёный.
- Staging gate последнего финального прохода: `23978472882`.
- Автоматические regressions теперь покрывают: same-browser tabs identity, `Hall` web-web visibility, `Hall` hand visibility, `demo-room` two-client sync, scene selector transitions, reconnect recovery, adaptive transport counters и secure staging room links.

## Риски и откаты (roll-back)

- Риск: Phase 2 снова разрастётся в монолитный `apps/runtime-web/src/main.ts`.
  - Откат: вынести publish/ingest/buffer orchestration в `apps/runtime-web/src/avatar/*`, оставить `main.ts` только wiring-слоем.
- Риск: `room-state` relay начнёт смешивать snapshot комнаты и transient pose path.
  - Откат: держать avatar relay как отдельные message types без встраивания pose в `room_state` snapshot.
- Риск: отсутствие ordering/buffer discipline даст дёрганый remote motion.
  - Откат: сначала зафиксировать `seq` rules и ring buffer, потом включать interpolation/extrapolation.
- Риск: reconnect/late join создадут дубликаты remote avatars.
  - Откат: считать `participantId` единственным identity key и централизовать cleanup/reset на disconnect/reconnect.
- Риск: realtime avatar sync создаст регрессии в текущем room flow.
  - Откат: feature flag должен полностью возвращать систему к coarse presence/capsule path; rollback deployment делается выключением флага и возвратом к текущему transport behavior.
