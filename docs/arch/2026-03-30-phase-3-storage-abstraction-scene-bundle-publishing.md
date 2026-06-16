# План: Phase 3 — storage abstraction и publish flow для scene bundles

## Цель

Вынести в `apps/api` минимальный storage abstraction для scene bundles и bundle-related artifacts, чтобы `noah` одинаково работал с локальным MinIO по умолчанию и с внешним `S3-compatible` backend вроде `Yandex Object Storage`, не меняя runtime contract: room manifest по-прежнему отдает только `sceneBundleUrl`.

## Не-цель

- Не внедрять registry-based CI/CD, auto-deploy и image rollout по SHA; это следующая фаза.
- Не делать production rollout.
- Не переводить runtime на signed URLs или приватные bundle downloads в этой фазе.
- Не строить полноценную asset management систему для всех типов медиа; фокус только на scene bundles и нужной metadata layer.
- Не ломать текущий room CRUD и existing `sceneBundleUrl` path для уже созданных staging rooms.

## Предпосылки и ограничения

- Phase 2 завершена: compose staging работает, public HTTPS URL есть, staging e2e покрывают текущий scene catalog.
- Сейчас room manifest в `apps/api/src/index.ts` читает `room.sceneBundleUrl` напрямую из storage layer и отдает его в `sceneBundle.url` без дополнительной storage-логики.
- Текущая persistence layer сосредоточена в `apps/api/src/storage.ts`; там уже есть `MemoryStorage` и `PostgresStorage`, а `room_records.scene_bundle_url` уже хранится в БД.
- MinIO уже поднимается в compose через `infra/docker/compose.staging.yml`, а bootstrap bucket path существует в `infra/docker/minio-bootstrap.sh`.
- Control plane уже умеет создавать/обновлять rooms с `sceneBundleUrl`, но не имеет нормализованного publish flow для bundle metadata.
- Важное ограничение: existing runtime/staging URLs не должны сломаться; Phase 3 должна быть backward-compatible для старых rooms с уже заданным `sceneBundleUrl`.
- Обязательная verification цепочка после значимых изменений этой фазы: локально `pnpm test:e2e`, затем staging publish/deploy, затем `pnpm test:e2e:staging`, плюс ручная проверка publish path хотя бы для одного bundle через MinIO/default backend.

## Подход

Сделать простой bundle storage contract внутри `api`: metadata живет в `postgres`, blob/public URL живет в `S3-compatible` storage. На первом шаге внедрить provider interface с двумя реализациями — `minio-default` и `s3-compatible` — и сохранить старый room-level `sceneBundleUrl` как поддерживаемый compatibility path. В этой фазе publish flow означает регистрацию bundle metadata по заранее известному `storageKey`/public URL и вычисление итогового public URL; полноценная загрузка bundle файлов через browser/API upload не входит в scope. Канонический runtime contract остается прежним: manifest читает `room.sceneBundleUrl`, а bind через bundle metadata только вычисляет и сохраняет итоговый URL в room record, без обязательного join с новой bundle table для legacy rooms.

## Задачи

### 1. Зафиксировать storage contract

- [x] Зафиксировать bundle metadata shape: `bundleId`, `storageKey`, `publicUrl`, `checksum`, `sizeBytes`, `contentType`, `provider`, `version`, `createdAt`.
- [x] Зафиксировать key layout для MinIO/S3, например `scenes/<bundle-id>/<version>/scene.json` и соседние bundle files.
- [x] Зафиксировать, какие env vars обязательны для default MinIO path и какие добавляются для внешнего S3-compatible backend (`endpoint`, `region`, `bucket`, `access key`, `secret key`, `public base URL`, `force path style`).
- [x] Зафиксировать compatibility rule: existing `room.sceneBundleUrl` продолжает работать без миграции.
- [x] Зафиксировать version rule: можно иметь несколько versions на один `bundleId`, но bind path в этой фазе всегда выбирает один явный `publicUrl` и сохраняет его в room record.

### 2. Подготовить metadata layer в `apps/api`

- [x] Добавить новую сущность bundle metadata в `apps/api/src/storage.ts` и интерфейс `Storage` для list/get/create/update bundle records.
- [x] Добавить память-based реализацию bundle metadata для `MemoryStorage`.
- [x] Добавить `postgres` schema/init path для bundle metadata таблицы без разрушения текущих room tables.
- [x] Зафиксировать migration/init behavior так, чтобы новый staging deploy создавал недостающую таблицу автоматически или предсказуемо падал с явной ошибкой.
- [x] Явно зафиксировать, что существующие room records не мигрируются автоматически в новую bundle metadata table; backfill остается вне scope Phase 3.

### 3. Вынести S3-compatible abstraction

- [x] Добавить в `apps/api` отдельный storage provider interface для bundle blobs/public URL resolution.
- [x] Реализовать MinIO provider как default provider для compose/self-hosted path.
- [x] Реализовать generic S3-compatible provider через env-config, совместимый с `Yandex Object Storage`.
- [x] Зафиксировать единый метод получения public URL, чтобы runtime и control-plane не знали о backend-specific details.

### 4. Добавить минимальный publish/read API path

- [x] Добавить API endpoint(ы) для регистрации bundle metadata и получения списка/деталей bundles.
- [x] Добавить минимальный publish flow: API принимает metadata payload для bundle по заранее известному `storageKey`/public URL и вычисляет/возвращает итоговый public URL по выбранному provider.
- [x] Добавить возможность привязать room к bundle metadata без ручного копирования URL, но сохранить старый room update path с прямым `sceneBundleUrl`.
- [x] Зафиксировать error semantics: missing bucket/key/provider config должны давать явную API error, а не тихий fallback.

### 5. Обновить control-plane минимально и без оверинжиниринга

- [x] Добавить в `apps/control-plane` read-only отображение bundle metadata для выбранной room, если bundle зарегистрирован через новый API path.
- [x] При необходимости добавить простой manual bind flow: выбрать bundle id или вставить URL, без полноценного browser upload UI в этой фазе.
- [x] Убедиться, что existing room create/update flow с `sceneBundleUrl` не ломается.

### 6. Проверить local MinIO path

- [x] Поднять compose stack локально с default MinIO provider.
- [x] Проверить создание bundle metadata record и получение public URL через API.
- [x] Привязать тестовую room к bundle через новый path и убедиться, что manifest отдает ожидаемый `sceneBundleUrl`.
- [x] Прогнать локальный `pnpm test:e2e` после изменений.

### 7. Проверить alternate S3-compatible path

- [x] Добавить documented env profile для внешнего S3-compatible backend без смены runtime contract.
- [x] Проверить хотя бы smoke-уровень формирования public URL/config для внешнего backend path.
- [x] Если полноценный live external bucket в этой фазе недоступен, зафиксировать contract test/mock coverage и ручную команду для реальной проверки позже.

### 8. Проверить staging и publish flow

- [x] Опубликовать изменения на compose staging host.
- [x] Проверить, что existing scene rooms не сломались после bundle metadata/storage abstraction изменений.
- [x] Проверить staging publish flow хотя бы для одного bundle через default MinIO path.
- [x] Прогнать `pnpm test:e2e:staging`.
- [x] Ручно проверить минимум одну newly bound room и одну legacy room с прямым `sceneBundleUrl`.

### 9. Зафиксировать rollback path

- [x] Зафиксировать rollback path для API/schema/provider changes без удаления `postgres` и `minio` volumes.
- [x] Убедиться, что rollback не ломает existing rooms, даже если новые bundle metadata записи уже появились.
- [x] Проверить rollback smoke: `/health`, `demo-room`, и одна existing scene room после отката.

## Затронутые файлы/модули

- `apps/api/src/storage.ts`
- `apps/api/src/index.ts`
- `apps/api/src/index.test.ts`
- `apps/api/src/**` новый storage/provider code
- `apps/control-plane/src/index.ts`
- `apps/control-plane/src/main.ts`
- `tests/e2e/runtime.spec.ts`
- `tests/e2e/runtime-staging.spec.ts`
- `infra/docker/compose.staging.yml`
- `infra/docker/.env.staging.example`
- `infra/docker/minio-bootstrap.sh`
- `README.md`
- `docs/deployment-yandex-cloud.md`
- `docs/architecture.md` (если понадобится обновить storage diagram)

## Тест-план

- **Unit / API contract**
- [x] Тесты на bundle metadata CRUD в `MemoryStorage` и `PostgresStorage`.
- [x] Тесты на provider config validation: MinIO default path и S3-compatible path.
- [x] Тесты на backward compatibility: room с прямым `sceneBundleUrl` продолжает получать тот же manifest.

- **Integration / local compose**
- [x] Local compose stack с MinIO default backend поднимается без дополнительной ручной настройки.
- [x] Bundle metadata API возвращает корректный public URL.
- [x] Room, привязанная к bundle через новый path, получает валидный `sceneBundle.url` в manifest.
- [x] Локально проходит `pnpm test:e2e`.

- **Staging**
- [ ] После deploy проходит `pnpm test:e2e:staging`.
- [x] Existing restored scene catalog не ломается.
- [x] Минимум один bundle проходит publish/bind path на staging через default MinIO provider.

- **Негативные кейсы**
- [x] При отсутствии обязательных storage env vars API явно сигнализирует `misconfigured_storage_provider` или эквивалентную ошибку.
- [x] При отсутствии bucket/key publish path падает предсказуемо, а не создает битую room binding.
- [x] При недоступном external S3 endpoint API возвращает явную operational error. В текущем scope это выражается через fail-fast config validation до bind/publish, так как live network upload не выполняется.
- [x] Legacy room с прямым `sceneBundleUrl` не зависит от новой metadata таблицы и не ломается, если provider path временно недоступен.
- [x] Bind через bundle metadata не ломает legacy room update/delete flow.

## Риски и откаты (roll-back)

- Риск: storage abstraction перерастет в сложную файловую платформу.
  - Откат: ограничить Phase 3 только scene bundles и metadata, без полноценного upload UI и version lifecycle manager.
- Риск: новая metadata layer сломает existing room manifest path.
  - Откат: room manifest должен по-прежнему брать `room.sceneBundleUrl` как source of truth, а новый bind path только упрощает его заполнение.
- Риск: MinIO и внешний S3 path начнут расходиться по URL semantics.
  - Откат: держать единый public URL contract и одинаковый key layout.
- Риск: schema change усложнит rollback.
  - Откат: добавлять новую таблицу/колонки append-only style; rollback не удаляет volumes и не требует destructive migration.
- Риск: staging publish path создаст новые bundle records, которые не понимает старая версия API.
  - Откат: проверять rollback на legacy rooms и не делать новую metadata таблицу обязательной для чтения старых rooms.

## Definition of done для Phase 3

- [x] В `apps/api` есть storage abstraction для scene bundle metadata и blob/public URL provider path.
- [x] MinIO работает как default self-hosted backend.
- [x] Есть config-compatible path для внешнего S3-compatible backend.
- [x] Existing rooms с прямым `sceneBundleUrl` продолжают работать без миграции.
- [x] Есть минимальный publish/bind API path для bundle metadata.
- [x] Room manifest по-прежнему строится только из `room.sceneBundleUrl` и не требует bundle metadata lookup для legacy rooms.
- [x] Локально проходит `pnpm test:e2e`.
- [x] На staging проходит `pnpm test:e2e:staging` и хотя бы один publish flow через default MinIO provider.
- [x] Есть документированный rollback path, проверенный smoke-проверкой.

## Итог выполнения

- Phase 3 завершена: bundle metadata layer, provider abstraction, minimal publish/bind API path, control-plane bind flow, local compose verification, staging verification и rollback smoke доведены до рабочего состояния.
- Канонический runtime contract не менялся: manifest по-прежнему читает `room.sceneBundleUrl`, а bundle metadata только помогает вычислить и сохранить этот URL.
- Default self-hosted provider подтвержден через MinIO path; config-compatible S3-compatible path задокументирован и покрыт contract tests на URL/config resolution.
- Live external S3 bucket в этой фазе не поднимался; вместо этого зафиксированы env contract, provider validation и ручной smoke path для последующей реальной проверки.
