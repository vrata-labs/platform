# План: docker compose, MinIO/S3 storage и CI/CD для single-VM и staging

## Цель

Перевести текущий staging/self-hosted контур `noah` на воспроизводимую схему из Docker-образов и `docker compose`, чтобы проект можно было развернуть на одной VM без vendor lock-in, а затем без смены контрактов переключать object storage на S3-совместимый backend вроде `Yandex Object Storage`. Одновременно внедрить CI/CD pipeline, который после коммита автоматически прогоняет тесты, публикует образы в registry, выкатывает staging и запускает staging `e2e`.

## Не-цель

- Не внедрять Kubernetes, Helm, ArgoCD или другой тяжелый orchestration stack на этом этапе.
- Не перестраивать продуктовую архитектуру вокруг managed cloud services как обязательной зависимости.
- Не делать production rollout в рамках первой итерации; сначала нужен надежный staging/self-hosted path.
- Не переносить rooms в модель "одна комната = один контейнер"; room остается записью в control-plane/API.
- Не делать закрытый bundle delivery через signed URLs в первой версии, если public-read URL достаточно для web runtime.

## Предпосылки и ограничения

- Текущие основные сервисы: `apps/api`, `apps/runtime-web`, `apps/control-plane`, `apps/room-state`, `LiveKit`, `Postgres`, `Caddy`.
- Сейчас staging уже живет на одной VM, но deploy path частично ручной и зависит от состояния конкретной машины.
- `apps/api` уже выступает как главный backend entrypoint: room CRUD, manifest generation, media/state token minting, выдача room links и статической сборки runtime/control-plane.
- `apps/runtime-web` и `apps/control-plane` уже собираются в `dist` и могут упаковываться в образ вместе с `api`.
- Scene bundles уже используются через `sceneBundleUrl`; runtime не должен знать, локальный это storage, MinIO или внешний S3.
- Для "из коробки" self-hosted сценария нужен one-VM deployment path без обязательной зависимости от облачного object storage.
- Для более серьезных сред нужен совместимый storage path, позволяющий переключиться на `Yandex Object Storage` только через env/config.
- После любых runtime/deploy/staging изменений по умолчанию обязательны: `pnpm test:e2e`, публикация на staging, `pnpm test:e2e:staging`, и проверка ключевых staging flows.

## Выбранный подход

Использовать hybrid storage и single-VM compose deployment:

1. Упаковать `api` и `room-state` в Docker-образы; `runtime-web` и `control-plane` доставлять внутри `api`-образа.
2. На VM поднимать stack через `docker compose`: `caddy`, `api`, `room-state`, `livekit`, `postgres`, `minio`.
3. В `api` ввести storage abstraction для scene bundles и asset-like artifacts с двумя реализациями: local `MinIO` и внешний `S3-compatible` backend.
4. В CI/CD использовать `GitHub Actions` для тестов, сборки и публикации образов в `Yandex Container Registry`, затем деплоить staging по SSH через `docker compose pull && docker compose up -d`.
5. На self-hosted/single-VM окружениях по умолчанию использовать `MinIO`; на продуктовых окружениях переключать те же сервисы на `Yandex Object Storage` без изменения runtime/API контрактов.

## Целевая схема сервисов

### Runtime and control-plane delivery

- `api` image содержит backend code, собранный `apps/runtime-web/dist` и `apps/control-plane/dist`.
- `api` отдает room manifests, control-plane API и статические ассеты веб-приложений.
- `caddy` принимает внешний трафик и reverse-proxy'ит запросы к `api`, `room-state` и `livekit`.

### Realtime and media

- `room-state` остается отдельным сервисом и отдельным Docker-образом.
- `livekit` используется как отдельный контейнер на официальном image.
- `api` продолжает mint'ить media/state токены и прокидывать нужные публичные URL в manifest.

### Data and artifact storage

- `postgres` хранит rooms, tenants, templates, scene bundle metadata и deployment-related metadata.
- `minio` поднимается в compose по умолчанию для single-VM/self-hosted режима.
- Scene bundles и связанные артефакты хранятся через единый `S3-compatible` storage contract.
- При переходе на `Yandex Object Storage` меняются только env/config: endpoint, bucket, credentials, public base URL.

## Фазы внедрения

### Phase 0 - Зафиксировать целевую схему и контракты

- [ ] Описать целевой `docker compose` stack и обязательные сервисы.
- [ ] Зафиксировать список env vars для `api`, `room-state`, `livekit`, `postgres`, `caddy`, `minio`.
- [ ] Зафиксировать storage contract для scene bundles: key format, public URL format, delete/update semantics.
- [ ] Зафиксировать, что room по-прежнему разворачивается как запись в API/DB, а не как отдельный контейнер.
- [ ] Зафиксировать default verification flow: local full `e2e` -> staging deploy -> staging `e2e`.

### Phase 1 - Dockerize приложения

- [ ] Добавить production Dockerfile для `apps/api`, который собирает workspace и включает `runtime-web` + `control-plane` dist.
- [ ] Добавить production Dockerfile для `apps/room-state`.
- [ ] Проверить, что локальный запуск контейнеров поднимает `api` и `room-state` без зависимости от локального node/pnpm окружения.
- [ ] Зафиксировать healthchecks для `api` и `room-state`.
- [ ] Добавить `.dockerignore` и убедиться, что образы не тянут лишние research/assets вне runtime path.

### Phase 2 - Compose stack для single-VM

- [ ] Создать `docker-compose.yml` или `compose.staging.yml` для `caddy`, `api`, `room-state`, `livekit`, `postgres`, `minio`.
- [ ] Добавить volumes для `postgres`, `minio`, `caddy-data`, `caddy-config`.
- [ ] Добавить init/bootstrap path для bucket creation и basic public-read policy в MinIO.
- [ ] Поднять stack локально или на test VM одной командой `docker compose up -d`.
- [ ] Проверить room load, presence, audio join, control-plane и selector flow в compose-режиме.

### Phase 3 - Storage abstraction и scene bundle publishing

- [ ] Вынести в `api` storage abstraction для scene bundles (`S3-compatible` interface).
- [ ] Реализовать MinIO backend как default self-hosted storage provider.
- [ ] Реализовать внешний S3-compatible backend через env-config, совместимый с `Yandex Object Storage`.
- [ ] Сохранить текущий runtime contract: runtime получает только `sceneBundleUrl`.
- [ ] Добавить metadata layer в `postgres`: bundle key, public URL, checksum/size, optional version.
- [ ] Зафиксировать первый publish path: public-read URLs; signed URLs оставить на следующий этап.

### Phase 4 - CI для тестов и сборки образов

- [ ] Обновить GitHub Actions workflow: `install`, `lint`, `typecheck`, `test`, `pnpm test:e2e`.
- [ ] Добавить `docker build` для `api` и `room-state`.
- [ ] Добавить `docker push` в `Yandex Container Registry` с immutable tags по `git sha`.
- [ ] Добавить дополнительные alias tags для удобства (`staging`, branch tag), не заменяя immutable SHA tag.
- [ ] Зафиксировать rule: deploy на staging всегда идет по конкретному SHA image tag.

### Phase 5 - CD на staging VM

- [ ] Подготовить staging VM под `docker compose` deploy path: compose file, env file, registry login, persistent volumes.
- [ ] Заменить ручной `rsync` как основной deploy path на `docker compose pull && docker compose up -d`.
- [ ] Добавить GitHub Actions deploy job, который по SSH обновляет `IMAGE_TAG` и выполняет compose rollout.
- [ ] Добавить post-deploy checks: `/health`, room shell, control-plane reachability.
- [ ] Зафиксировать rollback path: повторный deploy предыдущего image SHA.

### Phase 6 - Staging verification как обязательный gate

- [ ] Автоматически запускать `pnpm test:e2e:staging` после staging deploy.
- [ ] Расширить staging smoke до ключевых flows: room load, selector/navigation, presence, control-plane smoke, ключевые scene rooms (`Hall`, `Blue Office`).
- [ ] Зафиксировать, какие staging tests обязательны всегда, а какие только для runtime/scene/deploy изменений.
- [ ] Сделать deploy job failed, если staging smoke failed.
- [ ] При необходимости добавить простой rollback step на previous SHA, если staging smoke failed после rollout.

### Phase 7 - Productized artifact publishing

- [ ] Добавить нормальный publish flow для scene bundles через API/control-plane.
- [ ] Разделить code deploy и bundle publish так, чтобы правка bundle не требовала пересборки всех app images, если используется object storage backend.
- [ ] Добавить metadata/versioning policy для room -> bundle binding.
- [ ] Добавить cleanup policy для старых bundle versions в storage.
- [ ] Подготовить switch guide: MinIO -> Yandex Object Storage.

## Минимальный MVP order

Если делать максимально прагматично и поэтапно, порядок такой:

1. Dockerfile для `api` и `room-state`.
2. Compose stack для single-VM.
3. Перевод staging VM на compose, пока еще без нового scene bundle publish flow.
4. GitHub Actions: tests + build + push images.
5. GitHub Actions: deploy staging + `pnpm test:e2e:staging`.
6. Storage abstraction + MinIO default backend.
7. Внешний S3/Yandex Object Storage как alternate backend.

Это дает быстрый operational выигрыш уже после первых этапов, не дожидаясь полной productization storage layer.

## Затронутые модули и файлы

- `apps/api/**`
- `apps/room-state/**`
- `apps/runtime-web/**`
- `apps/control-plane/**`
- `packages/templates/**`
- `tests/e2e/**`
- `.github/workflows/**`
- `infra/docker/**` или `deploy/**`
- `infra/yandex/**`
- `docker-compose*.yml`
- `.env.example`
- `docs/architecture.md`
- `README.md`

## Тест-план

- **Container build**
- [ ] `api` image собирается воспроизводимо в CI.
- [ ] `room-state` image собирается воспроизводимо в CI.

- **Compose integration**
- [ ] `docker compose up -d` поднимает все сервисы на чистой VM.
- [ ] `/health` отвечает через `caddy`.
- [ ] `runtime-web` и `control-plane` доступны через публичные URL.
- [ ] `room-state` и `livekit` reachable через публичные endpoints из manifest.

- **Storage**
- [ ] MinIO backend корректно отдает public bundle URL.
- [ ] S3-compatible backend корректно отдает тот же runtime-visible contract.
- [ ] Room с `sceneBundleUrl` работает одинаково через MinIO и через Yandex Object Storage.

- **CI/CD**
- [ ] `push` запускает local test suite и build images.
- [ ] Образы публикуются в registry с immutable SHA tags.
- [ ] Deploy staging тянет нужные образы по SHA и поднимает обновленный compose stack.
- [ ] После deploy автоматически проходит `pnpm test:e2e:staging`.

- **Staging smoke**
- [ ] Открытие `Demo Room`.
- [ ] Переключение selector между room links.
- [ ] Presence API/live state smoke.
- [ ] Control-plane smoke.
- [ ] Key scene rooms `Hall` и `Blue Office` загружаются на staging.

## Риски и откаты

- Риск: compose stack станет слишком сложным для self-hosted пользователей.
  - Откат: держать один основной compose profile без лишних optional services; advanced profiles добавлять отдельно.
- Риск: ранний переход на object storage abstraction затянет сроки.
  - Откат: сначала dockerize/deploy pipeline, затем storage abstraction как отдельная фаза.
- Риск: bundling runtime/control-plane внутрь `api` image усложнит пересборку.
  - Откат: при росте проекта вынести static serving в отдельный container, но не делать это в первой итерации.
- Риск: staging deploy по SSH останется хрупким.
  - Откат: хранить compose/env на VM как стабильный runtime contract, а по SSH обновлять только image tag и вызывать `docker compose`.
- Риск: public-read bundles окажутся неприемлемыми для некоторых сред.
  - Откат: добавить signed URL mode поверх той же storage abstraction без изменения runtime boot flow.

## Definition of done для roadmap phase 1

- [ ] `api` и `room-state` собираются в Docker images.
- [ ] Single-VM stack поднимается через `docker compose`.
- [ ] Staging deploy идет из registry по image SHA, а не через `rsync` workspace.
- [ ] После deploy автоматически запускается `pnpm test:e2e:staging`.
- [ ] Scene bundles работают хотя бы через MinIO default path без изменения runtime contract.
- [ ] Переключение на внешний S3-compatible backend требует только env/config changes.
