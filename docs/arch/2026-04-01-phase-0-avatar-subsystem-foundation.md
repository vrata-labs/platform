# План: Phase 0 — контракты, ассеты, каркас avatar subsystem

## Цель

Подготовить Phase 0 из `docs/2026-04-01-noah-avatar-system-tz-roadmap.md` так, чтобы следующая реализация аватаров шла через отдельную подсистему, новые versioned contracts и управляемый asset path, а не через дальнейшее разрастание `apps/runtime-web/src/main.ts` и текущего coarse presence state.

## Не-цель

- Не внедрять networking pose sync между участниками.
- Не делать lipsync.
- Не делать legs / локомоционный body solve.
- Не делать seating.
- Не доводить до продуктовой кастомизации аватара; в Phase 0 нужен только `AvatarRecipeV1` contract.
- Не полагаться на постоянный legacy-compat слой, если проще выполнить явную миграцию текущих manifest/state contracts.

## Предпосылки и ограничения

- ТЗ Phase 0 уже фиксирует обязательный объём: `AvatarReliableState`, `CompactPoseFrame`, `AvatarRecipeV1`, `apps/runtime-web/src/avatar/*`, avatar catalog/recipe contracts, единый `humanoid-v1` rig, loader path с `KTX2Loader`/`MeshoptDecoder`/`DRACOLoader`, feature flags и debug UI.
- В текущем коде нет выделенной avatar subsystem: логика runtime сосредоточена в `apps/runtime-web/src/main.ts`, remote presence использует coarse `PresenceState`, а `apps/room-state` и `apps/runtime-web/src/room-state-client.ts` пока знают только про JSON state updates.
- `packages/shared-types` сейчас минимален; avatar contracts логично вводить отдельными файлами, не раздувая старые типы.
- `packages/asset-pipeline` сейчас умеет только базовую валидацию размера/расширения, поэтому Phase 0 должна явно добавить avatar-specific validator и CI gate.
- Допустимо использовать технические avatar assets для sandbox/debug-проверки pack loading, если финальный production-набор ещё не готов.
- Совместимость со старыми runtime/manifest contracts не является обязательной сама по себе; если новые контракты чище, надо планировать явную миграцию данных и конфигурации.
- Несмотря на отсутствие требования совместимости, fallback в capsule avatars остаётся обязательным operational safety path по ТЗ.

## Подход

Сначала вынести типы и границы подсистемы: отдельные shared contracts, versioned manifest additions и отдельный `apps/runtime-web/src/avatar/` каркас. Затем подготовить asset path: единый avatar catalog/recipe contract, pack loader с поддержкой `meshopt`/`KTX2`/`draco`, validator и CI checks. После этого добавить минимальный sandbox/debug flow, который локально грузит avatar pack, даёт переключать пресеты и подтверждает fallback при ошибке загрузки. Всё, что относится к сетевому pose sync, lipsync, ногам и seating, оставить за пределами фазы.

## Статус

- Обновлено по фактическому прогрессу на `2026-04-02`.
- Phase 0 по сути реализована: contracts, manifest/avatar config, asset validator + `pnpm validate:avatars`, technical avatar fixtures, reserved feature flags, sandbox/debug flow, diagnostics API, control-plane fields для `avatarConfig`, backfill/legacy normalization и несколько extraction pass из `apps/runtime-web/src/main.ts` уже в репозитории.
- Оставшийся хвост носит характер финальной фиксации статуса: при желании можно отдельным follow-up убрать legacy acceptance path после завершения периода миграции, но для самой Phase 0 он больше не блокирует DoD.

## Задачи

### 1. Зафиксировать Phase 0 contracts

- [x] Добавить в `packages/shared-types` отдельные модули `avatar.ts`, `avatar-recipe.ts`, `avatar-transport.ts`.
- [x] Описать и экспортировать `AvatarInputMode`, `AvatarReliableState`, `CompactPoseFrame`, `AvatarRecipeV1` с явным `schemaVersion`/`recipeVersion`.
- [x] Зафиксировать contract для avatar catalog `v1`: идентификатор pack'а, список пресетов, ссылки на thumbnails, recipe mapping, rig id и asset version.
- [x] Зафиксировать `humanoid-v1` как единственный допустимый rig id для Phase 0.
- [x] Добавить unit-тесты на compile/runtime-совместимость новых shared contracts.

### 2. Подготовить минимальный runtime/API contract для Phase 0

- [x] Определить минимальные manifest additions для Phase 0: `avatarsEnabled`, `avatarCatalogUrl`, `avatarQualityProfile`, `avatarFallbackCapsulesEnabled`.
- [x] Обновить contract `RoomManifest` в API/runtime/shared types, чтобы avatar flags и avatar catalog URL были явно описанными без расширения realtime transport в этой фазе.
- [x] Если текущие room records не содержат нужных полей, добавить backfill/migration только для manifest-level avatar config.
- [x] Зафиксировать, какие legacy manifest fields временно сосуществуют с новым contract, а какие можно удалить после завершения миграции.
- [x] Покрыть тестами manifest build/read path для rooms с avatars enabled и disabled.

### 3. Выделить каркас avatar subsystem в runtime

- [x] Создать `apps/runtime-web/src/avatar/` и завести минимум файлов Phase 0: `avatar-types.ts`, `avatar-catalog.ts`, `avatar-loader.ts`, `avatar-instance.ts`, `avatar-registry.ts`, `avatar-reliable-state.ts`, `avatar-debug.ts`.
- [x] Оставить в `main.ts` только orchestration layer и точки подключения avatar subsystem. Основные avatar/scene/runtime startup ветки вынесены в отдельные session/runtime/debug/fallback/boot helper модули; remaining top-level flow в `main.ts` носит orchestration характер.
- [x] Не создавать в этой фазе рабочую реализацию `avatar-ik`, `avatar-locomotion`, `avatar-lipsync`, `avatar-seating`, но при необходимости добавить пустые интерфейсы/заглушки только там, где это помогает зафиксировать boundary.
- [x] Зафиксировать, что `CompactPoseFrame` и transport-related shared types вводятся как contracts only и не требуют runtime wiring в `apps/room-state`/`room-state-client` в рамках Phase 0.
- [x] Выделить отдельное avatar debug state/API вместо дальнейшего роста общего runtime debug payload.
- [x] Добавить unit-тесты на инициализацию avatar registry/loader/debug state без реального room networking.

### 4. Реализовать avatar asset loading path

- [x] Расширить `apps/runtime-web/src/scene-loader.ts` или вынести общий loader helper так, чтобы avatar path использовал `GLTFLoader` с `KTX2Loader`, `MeshoptDecoder` и `DRACOLoader` fallback.
- [x] Подготовить отдельный avatar loader API, который валидирует manifest/catalog до инстанцирования сцены.
- [x] Сделать так, чтобы сбой загрузки одного пресета или одного recipe entry не валил весь runtime.
- [x] Реализовать fallback path в capsule avatars при asset load failure, несовместимом rig/recipe или validator reject.
- [x] Покрыть тестами init/failure/fallback path для avatar loader.

### 5. Ввести avatar asset contracts и pipeline checks

- [x] Зафиксировать структуру runtime-ресурсов для `public/assets/avatars/`: `catalog.v1.json`, `avatar-pack.v1.glb`, `avatar-recipes.v1.json`, `thumbs/*`.
- [x] Добавить в `packages/asset-pipeline` avatar validator с отдельным входным форматом для pack/catalog/recipes.
- [x] Реализовать проверяемые budget checks: triangles, materials, textures, file size.
- [x] Реализовать required checks: morph targets, animation clips, rig compatibility, identical skeleton signature across presets.
- [x] Добавить CI gate для avatar pack и зафиксировать отдельную blocking command/job, которая фейлит merge при нарушении rig/morph/clip/budget checks.
- [x] Подготовить технический avatar pack/fixtures для локальной проверки sandbox path.
- [x] Зафиксировать acceptance rule для technical assets: pack считается достаточным для Phase 0, если содержит 10 переключаемых пресетов, использует `humanoid-v1` и проходит validator checks без требования финального art polish.

### 6. Добавить feature flags и debug/sandbox flow

- [x] Расширить API health/manifest feature flags: `avatarsEnabled`, `avatarPoseBinaryEnabled`, `avatarLipsyncEnabled`, `avatarLegIKEnabled`, `avatarSeatingEnabled`, `avatarCustomizationEnabled`, `avatarFallbackCapsulesEnabled`.
- [x] Определить, какие из них реально участвуют в Phase 0 runtime flow, а какие пока только резервируются и прокидываются контрактом.
- [x] Добавить sandbox/debug режим, в котором runtime может локально загрузить avatar pack и переключать все пресеты без room networking.
- [x] Зафиксировать форму sandbox entrypoint: отдельный route, query flag или debug page.
- [x] Вынести avatar-related debug UI из общего ad-hoc debug panel в отдельный блок/модуль.
- [x] Показать в avatar diagnostics минимум: load status, selected preset, validator result, fallback reason.
- [x] Проверить, что выключение `avatarsEnabled` и/или срабатывание fallback-флага возвращает runtime в capsule path.

### 7. Проверить завершённость фазы по DoD

- [x] Подтвердить, что в репозитории есть отдельные avatar types и runtime modules, а не только изменения в `main.ts`.
- [x] Подтвердить, что runtime умеет локально загрузить avatar pack и показать все 10 пресетов в sandbox/debug режиме.
- [x] Подтвердить, что каждый пресет проходит validator checks: rig compatibility, morphs, clips, budgets.
- [x] Подтвердить, что avatars включаются и выключаются feature flag'ом.
- [x] Подтвердить, что при load failure runtime деградирует в capsule avatars без падения room flow.

## Затронутые файлы/модули

- `docs/2026-04-01-noah-avatar-system-tz-roadmap.md`
- `docs/architecture.md`
- `docs/runtime.md`
- `packages/shared-types/src/index.ts`
- `packages/shared-types/src/avatar.ts`
- `packages/shared-types/src/avatar-recipe.ts`
- `packages/shared-types/src/avatar-transport.ts`
- `packages/shared-types/src/index.test.ts`
- `packages/asset-pipeline/src/index.ts`
- `packages/asset-pipeline/src/validator.ts`
- `packages/asset-pipeline/src/**` новые avatar validator helpers/tests
- `apps/runtime-web/src/main.ts`
- `apps/runtime-web/src/index.ts`
- `apps/runtime-web/src/scene-loader.ts`
- `apps/runtime-web/src/avatar/*`
- `apps/runtime-web/public/assets/avatars/*`
- `apps/api/src/index.ts`
- `apps/api/src/storage.ts`
- `apps/runtime-web/src/room-state-client.ts` — не обязателен для Phase 0; менять только если это нужно для compile-time contract wiring без transport behavior changes
- `apps/room-state/src/*` — не обязательны для Phase 0; изменения допустимы только если нужны для compile-time shared contract alignment без запуска нового realtime path

## Тест-план

- **Unit**
- [x] Тесты на schema/type contracts для `AvatarReliableState`, `CompactPoseFrame`, `AvatarRecipeV1`, avatar catalog `v1`.
- [x] Тесты на manifest feature flag resolution и avatar manifest fields.
- [x] Тесты на avatar loader init path, validator reject path и capsule fallback path.
- [x] Тесты на avatar validator budgets, morph checks, clip checks, rig compatibility и skeleton signature.

- **Integration**
- [x] Локальная проверка sandbox/debug flow: runtime поднимается, грузит technical avatar pack и даёт переключить все 10 пресетов.
- [x] Интеграционная проверка API/runtime manifest path с `avatarsEnabled=true` и `avatarsEnabled=false`.
- [x] Интеграционная проверка миграции/backfill: существующие room records получают нужные avatar fields без ручной правки каждой комнаты.
- [x] Интеграционная проверка, что `CompactPoseFrame`/transport contracts можно импортировать и использовать как shared types без включения нового binary relay path.

- **E2E / smoke**
- [x] Прогнать базовый локальный набор проверок проекта: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`.
- [x] Если sandbox/debug flow попадает в browser path, добавить smoke на открытие runtime и успешную загрузку avatar sandbox режима.
- [x] Запускать avatar pack validation в отдельной blocking CI job/command и считать её обязательной частью Phase 0 verification.

- **Негативные кейсы**
- [x] Невалидный `avatarCatalogUrl` не приводит к падению runtime; включается fallback.
- [x] Один битый preset/recipe entry не ломает остальные пресеты.
- [x] Pack без обязательных morph targets или clips отклоняется validator'ом.
- [x] Preset с несовместимым skeleton signature отклоняется validator'ом.
- [x] Отключённый `avatarsEnabled` не оставляет runtime в частично инициализированном avatar state.
- [x] Миграция не оставляет room manifest в промежуточном несогласованном состоянии.

## Риски и откаты (roll-back)

- Риск: Phase 0 снова разрастётся внутрь `apps/runtime-web/src/main.ts`.
  - Откат: считать обязательным критерием завершения наличие отдельного `apps/runtime-web/src/avatar/` и orchestration-only роли для `main.ts`.
- Риск: новые manifest/state contracts окажутся грязным гибридом legacy и avatar path.
  - Откат: предпочесть явную миграцию/backfill и удалить лишний временный слой, если он мешает Phase 1/2.
- Риск: в Phase 0 незаметно протащится transport scope из следующих фаз.
  - Откат: оставить `CompactPoseFrame` и transport contracts на уровне shared types only; любые runtime/server transport changes вынести в отдельную следующую фазу.
- Риск: validator окажется слишком слабым и не поймает rig/clip/morph проблемы до runtime.
  - Откат: сделать CI gate блокирующим и не считать Phase 0 завершённой без avatar pack checks.
- Риск: загрузка pack'а сломается на части браузеров из-за неполной настройки `meshopt`/`KTX2`/`draco` path.
  - Откат: оставить capsule fallback обязательным и зафиксировать причину в diagnostics/debug UI.
- Риск: миграция manifest-level avatar config оставит комнаты в неконсистентном состоянии.
  - Откат: миграцию делать идемпотентной, с возможностью вернуть room manifest к capsule-only path через `avatarsEnabled=false` и `avatarCatalogUrl` unset без ручной чистки runtime state.
- Риск: отсутствие финальных production-ассетов затормозит Phase 0.
  - Откат: использовать технический avatar pack, если он соблюдает `humanoid-v1` contract и позволяет проверить loader/validator/sandbox.
