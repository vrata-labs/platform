# План: Phase 1 — локальный self-avatar и локальный body solve

## Цель

Реализовать в runtime полноценный локальный self-avatar без сетевого обмена: инстанцирование выбранного аватара в реальной комнате, локальный tracking root/head/hands, базовый upper-body solve, локальная locomotion state machine и предсказуемые self-visibility rules для VR, desktop и mobile.

## Не-цель

- Не делать remote avatars и pose sync.
- Не подключать authoritative transport, `room-state` relay и binary pose exchange.
- Не делать lipsync.
- Не делать seating.
- Не делать полную полировку ног, gait solver и foot planting из следующих фаз.
- Не превращать Phase 1 в новый animation framework или большой rewrite runtime.

## Предпосылки и ограничения

- Phase 0 уже подготовила базу: `apps/runtime-web/src/avatar/*`, avatar catalog/recipes, loader, diagnostics, sandbox и feature flags уже существуют.
- В текущем runtime есть только sandbox/debug avatar flow; self-avatar в реальной комнате ещё не подключён.
- `apps/runtime-web/src/xr.ts` пока даёт только detection helpers, поэтому XR input и controller mapping придётся расширять, но без разрастания новой логики обратно в монолитный `apps/runtime-web/src/main.ts`.
- В `apps/runtime-web/src/avatar/avatar-instance.ts` сейчас procedural/debug visual, а не полноценный self-avatar controller; Phase 1 должна добавить runtime-level controller/simulation layer поверх уже существующего catalog/loader path.
- Совместимость со старыми внутренними avatar contracts не является обязательной, если при выключенном avatar feature flag runtime возвращается к текущему room flow без регрессии.
- Обязательный крайний случай для этой фазы: безопасный fallback. Если avatar solve, input mapping или asset path ломаются, runtime должен деградировать в локальный safe behavior / capsule path, а не оставлять комнату в полусломанном состоянии.
- Источник выбора локального avatar preset в Phase 1 должен быть зафиксирован явно: либо room manifest default, либо local persisted override, либо deterministic hardcoded default для первой итерации.
- Источник animation clips для locomotion Phase 1 должен быть определён до начала реализации; если нужных clips нет в текущем pack, Phase 1 использует упрощённый animation selection и документированный fallback.
- План покрывает весь объём Phase 1 из ТЗ, но без scope creep в сеть, lipsync, seating и leg polish.
- Проверка завершения фазы должна включать не только локальные тесты, но и staging smoke после выкладки.

## Подход

Сохранить уже сделанные границы Phase 0 и добавить поверх них отдельный локальный self-avatar runtime pipeline: input capture -> avatar controller -> visibility policy -> upper-body solve -> locomotion state -> animation output. Сначала подключить self-avatar в обычный room flow за feature flag, затем ввести режимы ввода для VR/desktop/mobile и локальную state machine, после этого добавить безопасную деградацию и тесты. Всё, что относится к сети и remote avatars, оставить полностью вне фазы.

## Definition of Done

Фаза завершена, если:

1. При `avatarsEnabled=true` локальный self-avatar появляется в обычной комнате без sandbox/debug entrypoint.
2. В VR локальный пользователь видит self hands и устойчивое поведение корпуса без конфликта с камерой.
3. На desktop/mobile работает безопасный self-avatar fallback path без XR-controller зависимости.
4. Локальная locomotion state machine корректно переключает минимум `idle`, `walk`, `strafe`, `backpedal`, `turn`.
5. При ошибке input/solve/asset path runtime деградирует в `local-safe` path без поломки room controls.
6. При `avatarsEnabled=false` runtime возвращается к текущему поведению без регрессии.

## Статус на 2026-04-02

### Уже сделано

- [x] Локальный self-avatar поднимается в обычной комнате при `avatarsEnabled=true`, а не только в sandbox.
- [x] Есть отдельный local avatar controller, snapshot contract и transport-ready preview.
- [x] Есть self-visibility rules для `desktop`, `mobile`, `vr` и явные fallback profiles.
- [x] Есть базовый upper-body solve, procedural locomotion/animation layer и clip fallback.
- [x] Есть preset switching для self-avatar в обычной комнате.
- [x] Есть безопасный fallback path для broken catalog / partial XR input / clip fallback.
- [x] Есть outbound avatar publish boundary и inbound avatar message parsing через `room-state`.
- [x] Есть remote avatar runtime module со stub rendering, participant model и debug state.
- [x] Локальные проверки и staging verification многократно пройдены: `pnpm test`, `pnpm test:e2e`, staging deploy gate.

### Осталось до формального закрытия Phase 1

- [x] Финально пройти manual VR checklist на реальном WebXR/Quest path и зафиксировать результат.
- [ ] Решить, считаем ли текущий remote stub достаточным для границы Phase 1 или выносим его целиком в ранний Phase 2 scope.
- [x] Сверить Definition of Done с фактической реализацией и зачекать финальные пункты после ручной VR-проверки.

### Результат ручной VR-проверки

- [x] Проверка проведена на Quest 2 во встроенном браузере против staging-комнаты `2fd8517c-7096-48cb-b22f-4ba1ff3d6197`.
- [x] Комната загружается стабильно, self-avatar появляется в обычном room flow.
- [x] Left/right hand mapping подтверждён как корректный.
- [x] После серии VR фиксов устранены два ключевых бага Phase 1: разъезд рук после strafe и смещение рук относительно глаз после snap turn.
- [x] По итогам ручного прогона core VR path считается рабочим для Phase 1.

### Практический вывод

Phase 1 по коду, автопроверкам и ручной VR-проверке находится в practically-done состоянии: core local avatar path, diagnostics, transport boundary, remote stub path, staging gate и ручной Quest/WebXR pass уже есть. Оставшийся вопрос носит скорее scope-границу между поздним финалом Phase 1 и ранним стартом Phase 2: считать ли текущий remote stub достаточным как финальную границу фазы или сразу выносить его в следующий этап.

## Задачи

### 1. Подключить self-avatar к обычному room flow

- [ ] Добавить orchestration layer, которая создаёт локальный avatar session в реальной комнате, а не только в sandbox/debug режиме.
- [ ] Подключить выбранный avatar preset из catalog/runtime config к локальному player entity.
- [ ] Сделать так, чтобы `avatarsEnabled=false` полностью оставлял текущий room flow без self-avatar side effects.
- [ ] Обновить diagnostics/debug state так, чтобы в обычной комнате было видно: active preset, input mode, solve state, locomotion state, fallback reason.

### 2. Ввести локальный avatar controller и state model

- [ ] Добавить `apps/runtime-web/src/avatar/avatar-controller.ts` как единый вход для локального avatar update loop.
- [ ] Зафиксировать минимальный локальный avatar state: root pose, head pose, left/right hand pose, locomotion mode, visibility mode, fallback state.
- [ ] Разделить capture raw input и application to avatar rig, чтобы Phase 2 не была привязана к ad-hoc логике из `main.ts`.
- [ ] Ограничить Phase 1 только локальным authoritative state внутри клиента без изменений в `apps/room-state`.

### 3. Реализовать self-visibility rules для VR / desktop / mobile

- [ ] Ввести явные правила self-visibility для трёх режимов: VR, desktop, mobile.
- [ ] Для VR показывать self hands и body behavior без визуального конфликта с камерой/головой.
- [ ] Для desktop/mobile включить безопасный fallback avatar behavior без требования controller input.
- [ ] Зафиксировать и протестировать правило, что видимость переключается детерминированно при смене input mode и при входе/выходе из XR.

### 4. Реализовать local tracking для root / head / hands

- [ ] Расширить XR/input слой так, чтобы локальный avatar controller получал head/root/controller poses в одном согласованном формате.
- [ ] Для VR добавить controller-based hand mapping с безопасным поведением при отсутствии одного или обоих контроллеров.
- [ ] Для desktop/mobile определить минимальный локальный pose source: root и head обязательны, hands могут идти через fallback pose profile.
- [ ] Добавить нормализацию/ограничения поз, чтобы не появлялись экстремальные rotations и явные сломы скелета.

### 4a. Зафиксировать источник preset selection

- [ ] Определить единственный источник выбора локального avatar preset для обычной комнаты.
- [ ] Зафиксировать default behavior, если local override отсутствует или preset невалиден.

### 5. Добавить базовый upper-body solve

- [ ] Добавить `apps/runtime-web/src/avatar/avatar-ik.ts` с минимальным upper-body solve для head/arms без попытки решить полный body IK.
- [ ] Ограничить solve безопасными bounds для head tilt, arm reach и shoulder influence.
- [ ] Привязать solve к локальному avatar controller, а не напрямую к рендер-циклу в `main.ts`.
- [ ] Сделать fallback на упрощённую pose application, если solve не может выдать валидную позу.

### 6. Добавить локальную locomotion state machine и animation selection

- [ ] Добавить `apps/runtime-web/src/avatar/avatar-locomotion.ts` с минимальным набором состояний: `idle`, `walk`, `strafe`, `backpedal`, `turn`.
- [ ] Использовать уже доступные motion/root данные для вычисления направления движения, скорости и углового поворота.
- [ ] Зафиксировать проверяемые переходы между состояниями и hysteresis, чтобы убрать дёрганье на границах.
- [ ] Связать locomotion state с локальным animation graph/clip selection без захода в leg polish из Phase 3.

### 6a. Зафиксировать animation asset contract для Phase 1

- [ ] Проверить, какие clips реально доступны в текущем avatar pack.
- [ ] Если полного набора clips нет, зафиксировать упрощённый animation selection и fallback без расширения scope фазы.

### 7. Собрать безопасный fallback path для Phase 1

- [ ] Ввести единый fallback reason contract для ошибок loader, invalid solve, missing XR input и unsupported mode.
- [ ] Разделить `procedural self-avatar fallback` и `full room-flow fallback without self-avatar` и зафиксировать условия переключения.
- [ ] При критической ошибке self-avatar runtime не должен ломать room controls, camera и базовый player flow.
- [ ] Проверить, что desktop/mobile path остаётся рабочим, даже если XR-specific mapping не инициализировался.
- [ ] Проверить, что feature flag disable или runtime reset очищают self-avatar state без оставшихся scene artifacts.

### 8. Закрыть фазу проверками и документацией

- [ ] Обновить план/документацию по локальному avatar pipeline и границам между input, solve и locomotion.
- [ ] Добавить unit/integration tests для controller, visibility rules, locomotion transitions и fallback logic.
- [ ] Добавить manual QA checklist для VR/Desktop/Mobile.
- [ ] Подтвердить локальную зелёную проверку и staging smoke после выкладки.

## Затронутые файлы/модули

- `docs/2026-04-01-noah-avatar-system-tz-roadmap.md`
- `docs/plans/2026-04-01-phase-0-avatar-subsystem-foundation.md`
- `apps/runtime-web/src/main.ts`
- `apps/runtime-web/src/index.ts`
- `apps/runtime-web/src/xr.ts`
- `apps/runtime-web/src/motion-state.ts`
- `apps/runtime-web/src/avatar/avatar-runtime.ts`
- `apps/runtime-web/src/avatar/avatar-session.ts`
- `apps/runtime-web/src/avatar/avatar-instance.ts`
- `apps/runtime-web/src/avatar/avatar-debug.ts`
- `apps/runtime-web/src/avatar/avatar-types.ts`
- `apps/runtime-web/src/avatar/avatar-controller.ts` (новый)
- `apps/runtime-web/src/avatar/avatar-ik.ts` (новый)
- `apps/runtime-web/src/avatar/avatar-locomotion.ts` (новый)
- `apps/runtime-web/src/avatar/*.test.ts` новые и существующие тесты по controller/solve/locomotion/visibility
- `apps/runtime-web/src/xr.test.ts`
- `apps/runtime-web/src/index.test.ts`
- `apps/runtime-web/src/runtime-startup.test.ts`
- `apps/runtime-web/src/scene-session.ts` или соседний orchestration helper, если self-avatar wiring будет вынесен туда вместо `main.ts`

## Тест-план

- **Unit**
- [ ] Тесты на self-visibility rules для `vr`, `desktop`, `mobile`.
- [ ] Тесты на transitions локальной locomotion state machine: `idle/walk/strafe/backpedal/turn`.
- [ ] Тесты на hand/controller mapping и fallback при отсутствии контроллеров.
- [ ] Тесты на safe bounds upper-body solve: clamp rotations, arm reach, invalid pose reject.
- [ ] Тесты на feature flag disable/reset path.

- **Integration**
- [ ] Проверка, что self-avatar поднимается в реальной комнате при `avatarsEnabled=true`.
- [ ] Проверка, что при `avatarsEnabled=false` runtime работает по текущему room flow без регрессии.
- [ ] Проверка переключения input mode между desktop/mobile/VR и корректного пересчёта visibility/pose source.
- [ ] Проверка, что ошибка solve или XR input инициализации переводит систему в безопасный fallback, но не ломает room session.

- **E2E / smoke**
- [ ] Максимально покрыть фичу автоматическими e2e, а не оставлять проверку только на ручной QA или diagnostics-only assertions.
- [ ] Прогнать локально обязательный набор: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm test:e2e`.
- [ ] После внедрения выкатить изменения на опубликованный staging и прогнать `pnpm test:e2e:staging`.
- [ ] Проверить staging room load и avatar-enabled room flow хотя бы для базового desktop path; отдельно зафиксировать, как на stage включается avatar feature flag и какой room используется для smoke.
- [ ] Для новых user-facing behavior changes по возможности добавить отдельные staging-facing e2e assertions, а не ограничиваться только локальными тестами.
- [ ] Для runtime-значимых изменений дополнительно проверить VR/manual path на staging или на публично доступном окружении с теми же флагами.

- **Manual**
- [ ] Quest / WebXR: поднять руки, вращать контроллеры, двигаться, выполнить turn и убедиться, что self hands/body ведут себя стабильно.
- [ ] Desktop: двигаться мышью/клавиатурой и проверить переходы `idle/walk/turn` без частичного распада avatar state.
- [ ] Mobile: убедиться, что включается безопасный fallback behavior без XR-зависимых артефактов.

- **Негативные кейсы**
- [ ] Один или оба VR controller недоступны: self-avatar остаётся в валидном fallback pose.
- [ ] Upper-body solve выдаёт невалидную позу: применяется safe fallback без поломки сцены.
- [ ] Переключение XR -> non-XR и обратно не оставляет дубликаты avatar nodes и не ломает visibility rules.
- [ ] `avatarsEnabled` выключается во время session: self-avatar корректно убирается, room controls продолжают работать.
- [ ] Ошибка asset/init path не ломает локальный player flow и переводит runtime в capsule/local-safe behavior.

## Риски и откаты (roll-back)

- Риск: логика Phase 1 снова разрастётся в `apps/runtime-web/src/main.ts`.
  - Откат: держать `main.ts` только orchestration слоем; controller, solve и locomotion выносить в `apps/runtime-web/src/avatar/*`.
- Риск: Phase 1 незаметно потянет за собой сеть и `room-state` изменения.
  - Откат: запретить изменения transport scope в этой фазе; remote/avatar sync оставить только для Phase 2.
- Риск: VR-only реализация сломает desktop/mobile path.
  - Откат: сначала фиксировать единый local avatar state и fallback rules, потом добавлять XR-specific mapping как частный случай.
- Риск: solve окажется слишком амбициозным и нестабильным.
  - Откат: оставить базовый upper-body solve с жёсткими ограничениями и упрощённую pose application как допустимый fallback.
- Риск: локомоция будет дёргаться на границах состояний.
  - Откат: ввести hysteresis/min-speed thresholds и считать гладкие transitions важнее визуального богатства.
- Риск: включённый avatar feature flag создаст регрессии в существующем room flow.
  - Откат: feature flag должен полностью возвращать систему к текущему поведению; rollback deployment делается отключением флага и возвратом к capsule/local-safe path.
