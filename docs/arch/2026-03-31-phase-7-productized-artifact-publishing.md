# План: Phase 7 — productized artifact publishing для scene bundles

## Цель

Довести publish flow для scene bundles до продуктового состояния поверх уже существующей storage abstraction: отделить code deploy от bundle publish, ввести понятную metadata/versioning policy для room -> bundle binding, добавить cleanup policy для старых bundle versions и оформить практический switch guide `MinIO -> Yandex Object Storage` без изменения runtime contract.

## Не-цель

- Не добавлять полноценный browser upload UI архива/набора файлов в этой итерации.
- Не менять runtime boot contract: runtime по-прежнему получает только `sceneBundleUrl`.
- Не делать production rollout за пределами существующего staging/self-hosted path.
- Не строить сложную asset management платформу для всех типов медиа; фокус только на scene bundles.
- Не вводить signed/private bundle delivery как обязательный path.

## Предпосылки и ограничения

- Phase 3 уже дала базовый storage abstraction: `apps/api` умеет хранить bundle metadata, вычислять public URLs и привязывать room к bundle через сохранение `room.sceneBundleUrl`.
- Сейчас publish flow минимальный: metadata регистрируется по заранее известному `storageKey`/public URL, а не через полноценный upload pipeline.
- Phase 6 завершена: staging deploy и verification gate уже работают, поэтому Phase 7 не должна ломать существующий staging catalog и gate.
- Existing room/runtime compatibility должна сохраниться: legacy rooms с прямым `sceneBundleUrl` продолжают работать без миграции.
- Фаза из roadmap требует именно productized publishing: нормальный publish flow через API/control-plane, versioning policy, cleanup policy и switch guide `MinIO -> Yandex Object Storage`.
- Необходимо сохранить прагматичный scope: productized publish flow поверх metadata/binding path, без разрастания в тяжелый upload UI.

## Подход

Сделать Phase 7 как слой управления bundle lifecycle поверх уже существующей metadata модели. В этой фазе publish flow остается metadata-driven: новая bundle version регистрируется по заранее известному `storageKey`/`publicUrl`, без полноценного file upload. Bundle становится именованной сущностью с version policy и current binding semantics, room может быть привязана к конкретной current version через API/control-plane, а publish отдельного bundle не требует пересборки app images. Канонический runtime contract остается прежним: manifest по-прежнему строится через `room.sceneBundleUrl`, а versioning/binding logic только управляет тем, какой URL туда записывается. Cleanup policy и switch guide оформляются как явный operational contract, чтобы self-hosted MinIO и внешний `Yandex Object Storage` оставались взаимозаменяемыми через одинаковый key layout и env/config.

## Задачи

### 1. Зафиксировать productized publish contract

- [x] Зафиксировать сущности и поля publish flow: `bundleId`, `version`, `storageKey`, `publicUrl`, `provider`, `status`, `createdAt`, `isCurrent`.
- [x] Зафиксировать version policy: что считается current version, как room связывается с bundle, и когда current version обновляется.
- [x] Зафиксировать compatibility rule: room manifest все еще строится из `room.sceneBundleUrl`, а publish flow только управляет тем, какой URL туда попадает.
- [x] Зафиксировать, какие шаги publish flow обязательны всегда, а какие manual/operational.
- [x] Зафиксировать формат version identifier и правила uniqueness внутри `bundleId`.

### 2. Расширить metadata model и API

- [x] Добавить недостающие поля/таблицы для bundle versioning policy, если текущей `scene_bundles` metadata недостаточно.
- [x] Добавить API path для productized publish: создать новую bundle version, получить список versions и переключить current version.
- [x] Добавить API path для room -> bundle binding через current/versioned semantics, сохранив legacy direct URL path.
- [x] Зафиксировать error semantics: broken version switch, missing current version, conflict on duplicate version.
- [x] Явно зафиксировать migration/backfill policy для уже существующих bundle records Phase 3: без auto-backfill или с минимальным status-default path.

### 3. Обновить control-plane до productized publish flow

- [x] Показать для room не только список bundles, но и current version/current binding state.
- [x] Добавить минимальный UI flow для выбора bundle и version при bind к room.
- [x] Добавить минимальный publish metadata flow в control-plane без полноценного archive upload UI.
- [x] Убедиться, что старый create/update flow с прямым `sceneBundleUrl` остается рабочим.

### 4. Отделить bundle publish от code deploy

- [x] Зафиксировать, что обновление bundle metadata/current version не требует пересборки Docker images.
- [x] Проверить publish/update flow на staging без нового app image rollout.
- [x] Проверить, что room, привязанная к новой bundle version, начинает отдавать новый manifest URL без app redeploy.

### 5. Добавить cleanup policy для старых versions

- [x] Зафиксировать cleanup policy: сколько старых versions держим, что only-deprecate, что нельзя удалять, если room еще привязана.
- [x] Добавить API/operational path для mark-as-obsolete / cleanup-ready state.
- [x] Проверить, что cleanup policy не ломает rooms, которые еще используют старую version.
- [x] Cleanup в этой фазе только переводит старые versions в metadata state `obsolete` / `cleanup-ready` без физического удаления blob objects.

### 6. Подготовить switch guide MinIO -> Yandex Object Storage

- [x] Описать обязательные env/config differences между `minio-default` и `s3-compatible`/`Yandex Object Storage`.
- [x] Зафиксировать migration/switch sequence без изменения runtime contract.
- [x] Зафиксировать manual smoke checklist после switch.
- [x] Убедиться, что docs позволяют повторить switch без чтения кода.

### 7. Проверить local/staging flow

- [x] Локально проверить productized publish flow на MinIO default backend.
- [x] Проверить version switch для room без image rebuild.
- [x] Прогнать локальный `pnpm test:e2e` после изменений.
- [x] Опубликовать изменения на staging.
- [x] Прогнать `pnpm test:e2e:staging`.
- [x] Ручно проверить legacy room, room с current version binding и room после version switch.

### 8. Зафиксировать rollback path

- [x] Зафиксировать rollback path для metadata/versioning changes без удаления `postgres`/`minio` volumes.
- [x] Проверить rollback smoke на staging: `/health`, `demo-room`, одна legacy room, одна version-bound room.
- [x] Зафиксировать, как откатывается неудачный version switch без app redeploy.

## Затронутые файлы/модули

- `apps/api/src/storage.ts`
- `apps/api/src/index.ts`
- `apps/api/src/scene-bundle-storage.ts`
- `apps/api/src/**` новые bundle/version helpers
- `apps/control-plane/src/index.ts`
- `apps/control-plane/src/main.ts`
- `apps/control-plane/index.html`
- `tests/e2e/runtime.spec.ts`
- `tests/e2e/runtime-staging.spec.ts`
- `README.md`
- `docs/deployment-yandex-cloud.md`
- `docs/architecture.md` (если нужно обновить publish/storage diagram)

## Тест-план

- **Unit / API contract**
- [x] Тесты на version/current semantics для bundle metadata.
- [x] Тесты на room binding через current version и на backward-compatible direct URL path.
- [x] Тесты на ошибки duplicate version / missing current version / unsafe cleanup.

- **Integration / local**
- [x] Local MinIO publish flow создает новую bundle version и current binding без image rebuild.
- [x] Version switch обновляет room manifest URL предсказуемо.
- [x] Локально проходит `pnpm test:e2e`.

- **Staging**
- [x] После deploy проходит `pnpm test:e2e:staging`.
- [x] Existing restored scene catalog не ломается.
- [x] Productized publish flow проверен хотя бы для одного bundle/version switch на staging.

- **Негативные кейсы**
- [x] Broken version switch не оставляет room в битом manifest state.
- [x] Cleanup не удаляет version, пока она связана с room.
- [x] Legacy room с прямым `sceneBundleUrl` не зависит от новой version policy.
- [x] Switch guide path не требует code changes при переходе `MinIO -> Yandex Object Storage`.

## Риски и откаты (roll-back)

- Риск: versioning policy усложнит текущий простой contract `room.sceneBundleUrl`.
  - Откат: сохранять `room.sceneBundleUrl` каноническим runtime field и не делать manifest зависимым от сложного join/runtime lookup.
- Риск: cleanup policy может удалить still-used bundle versions.
  - Откат: cleanup только для unbound/obsolete versions с явной защитой от удаления active bindings.
- Риск: попытка сделать upload UI в этой фазе раздует scope.
  - Откат: оставить publish flow metadata-driven и отложить heavy upload UX отдельно.
- Риск: switch guide на внешний S3 backend останется теоретическим.
  - Откат: зафиксировать конкретный пошаговый contract и проверить хотя бы config-level smoke path.

## Definition of done для Phase 7

- [x] Есть productized publish flow для scene bundles через API/control-plane поверх существующей metadata/storage layer.
- [x] Room -> bundle binding поддерживает понятную current/version policy без ломки legacy URL path.
- [x] Bundle publish/version switch не требует пересборки app images.
- [x] Room manifest по-прежнему строится через `room.sceneBundleUrl` и не требует runtime lookup current version.
- [x] Есть зафиксированная cleanup policy для старых bundle versions.
- [x] Есть понятный switch guide `MinIO -> Yandex Object Storage`.
- [x] Локально проходит `pnpm test:e2e`.
- [x] На staging проходит `pnpm test:e2e:staging` и проверен хотя бы один productized version switch flow.
- [x] Rollback path для metadata/versioning изменений задокументирован и проверен smoke-проверкой.

## Итог выполнения

- Phase 7 завершена: publish flow для scene bundles стал productized поверх существующей metadata/storage abstraction без изменения runtime contract.
- Productized flow остается metadata-driven: новые versions регистрируются по заранее известному `storageKey`/`publicUrl`, room binding и version switch просто обновляют `room.sceneBundleUrl`.
- API теперь поддерживает version lifecycle: list versions, create version, set current version, mark status (`active`, `obsolete`, `cleanup-ready`).
- Control-plane поддерживает минимальный productized UI flow: publish новой version metadata, выбор version при bind, переключение current version и mark obsolete.
- Staging verification подтверждена без app rebuild: demo bundle `productized-demo` был опубликован на staging, привязан к room, затем current version переключена с `v2` на `v1`, и manifest URL изменился без image redeploy.
