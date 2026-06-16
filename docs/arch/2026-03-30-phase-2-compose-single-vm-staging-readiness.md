# План: Phase 2 — compose stack для single-VM со staging readiness

## Цель

Перевести текущий single-VM/staging runtime `noah` с systemd + workspace deploy на воспроизводимый `docker compose` stack, который поднимает `api`, `room-state`, `livekit`, `postgres`, `caddy` и `minio` одной командой, проходит локальную интеграционную проверку, затем публикуется на staging и подтверждается обязательными `e2e`/staging smoke проверками и понятным rollback path.

## Не-цель

- Не внедрять полный CI/CD pipeline с registry publish и auto-deploy; это остается следующей фазой roadmap.
- Не делать production rollout.
- Не внедрять полноценную storage abstraction в `api`; в этой фазе нужен только compose-ready MinIO path и bootstrap bucket.
- Не менять runtime contract для rooms/scenes: runtime по-прежнему получает `sceneBundleUrl`, room не становится отдельным контейнером.
- Не раскладывать stack по нескольким VM или k8s.

## Предпосылки и ограничения

- `apps/api` и `apps/room-state` уже dockerized и локально проходят container smoke.
- В репозитории уже есть локальный skeleton `infra/docker/docker-compose.local.yml` для `postgres` и `livekit`; его стоит использовать как отправную точку, а не изобретать новый формат.
- Текущий staging bootstrap живет в `infra/yandex/cloud-init/staging-scenes.yaml` и сейчас ставит `node`, `pnpm`, `systemd` units и делает `git clone` + `pnpm build`; Phase 2 должна убрать эту зависимость для runtime path.
- Уже есть GitHub workflow для локального `CI` в `.github/workflows/ci.yml` и ручной staging smoke workflow в `.github/workflows/staging-smoke.yml`; их контракты надо сохранить совместимыми.
- Обязательная verification цепочка для этой фазы: локально `pnpm test:e2e`, затем publish/deploy на staging, затем `pnpm test:e2e:staging` и ручная проверка ключевых flows.
- Phase 2 должна оставаться прагматичной: staging deploy может быть пока ручным по SSH/`docker compose`, но он должен быть повторяемым и документированным.

## Подход

Сделать один основной compose-файл для single-VM/staging с небольшим числом секретов и явными volumes, а staging перевести на тот же runtime contract, что и local compose. Для этой фазы staging deploy использует build на VM из текущей ветки репозитория: `git pull` -> `docker compose build` -> `docker compose up -d`; переход на registry/pull по SHA остается для следующей фазы. Сначала добиться локального `docker compose up -d` для всего stack, затем заменить staging bootstrap на compose-based deploy, после чего зафиксировать smoke/e2e/rollback как обязательный acceptance path для фазы.

## Задачи

### 1. Зафиксировать compose contract

- [x] Выбрать основной путь размещения compose-артефактов: `infra/docker/compose.staging.yml` + `infra/docker/.env.staging.example`.
- [x] Зафиксировать список обязательных env vars для `api`, `room-state`, `livekit`, `postgres`, `caddy`, `minio`.
- [x] Зафиксировать naming для volumes, container names и internal network.
- [x] Зафиксировать публичные URL/hostnames для `api`, `room-state` и `livekit`, чтобы они совпадали с manifest expectations.

### 2. Собрать compose stack

- [x] Добавить compose-файл для `caddy`, `api`, `room-state`, `livekit`, `postgres`, `minio`.
- [x] Добавить persistent volumes для `postgres`, `minio`, `caddy-data`, `caddy-config`.
- [x] Подключить `api` и `room-state` к существующим Docker images из репозитория, не требуя локального `pnpm` на VM.
- [x] Добавить `healthcheck`/`depends_on` там, где это реально помогает стартовому порядку, без переусложнения orchestration.
- [x] Подготовить `Caddyfile` или template-конфиг для reverse proxy на `api`, `room-state`, `livekit`.

### 3. Подготовить MinIO bootstrap path

- [x] Добавить bootstrap/init сервис или скрипт для создания bucket в MinIO после старта.
- [x] Настроить базовую public-read policy только для нужного bucket/path, без избыточно широких прав.
- [x] Зафиксировать key layout для scene bundle артефактов в MinIO как временный Phase 2 contract.
- [x] Подготовить один тестовый scene bundle publish path в MinIO и использовать его в acceptance room для проверки compose/staging runtime contract.
- [x] Проверить, что public URL из MinIO может использоваться как `sceneBundleUrl` без изменений в runtime.

### 4. Поднять и проверить stack локально

- [x] Поднять весь stack одной командой `docker compose up -d` на чистом локальном окружении.
- [x] Проверить через публичный compose entrypoint: `/health`, `/rooms/demo-room`, `/control-plane`, websocket/presence path, `livekit` reachability.
- [x] Проверить создание room и selector/navigation flow в compose-режиме.
- [x] Проверить, что room с `sceneBundleUrl`, указывающим на MinIO/public asset URL, открывается без регресса.
- [x] Прогнать локальный полный `pnpm test:e2e` после перехода на compose path.

### 5. Подготовить staging publish/deploy path

- [x] Обновить `infra/yandex/cloud-init/staging-scenes.yaml` или выделить новый cloud-init так, чтобы staging VM ставила Docker + Compose plugin вместо runtime через `node`/`systemd`.
- [x] Перенести runtime env/config в compose-friendly `.env` contract на staging VM.
- [x] Зафиксировать ручной staging deploy path: обновить ветку/артефакты на VM, выполнить `docker compose build`, затем `docker compose up -d`.
- [x] Зафиксировать, какие файлы должны жить на VM стабильно (`compose`, `.env`, volumes), а какие обновляются при rollout.
- [x] Добавить короткую инструкцию staging rollout в `README.md` или `docs/`.

### 6. Проверить staging после публикации

- [x] После локально зеленого `pnpm test:e2e` опубликовать изменения на текущий staging branch и поднять compose stack на staging.
- [x] Проверить staging `/health`, `/rooms/demo-room`, `/control-plane` и доступность публичных `livekit`/`room-state` endpoint'ов.
- [x] Запустить `pnpm test:e2e:staging` против актуального staging URL.
- [x] Ручно проверить ключевые staging flows: room load, selector/navigation, presence smoke, control-plane smoke.
- [x] Если изменение затрагивает scene delivery, отдельно проверить минимум `Hall` и `BlueOffice` на staging.

### 7. Зафиксировать rollback path

- [x] Зафиксировать быстрый rollback для staging на предыдущий git commit или предыдущие compose/image artifacts.
- [x] Убедиться, что rollback не трогает persistent data volumes `postgres` и `minio` без явной команды.
- [x] Подготовить пошаговую команду отката для неуспешного rollout по выбранному deploy path (`git checkout <prev>` + `docker compose build` + `docker compose up -d`).
- [x] Проверить rollback smoke: после отката снова доступны `/health` и базовый room load.

## Затронутые файлы/модули

- `infra/docker/docker-compose.local.yml`
- `infra/docker/**` или новый `compose`-файл рядом
- `infra/yandex/cloud-init/staging-scenes.yaml`
- `apps/api/**`
- `apps/room-state/**`
- `apps/runtime-web/**`
- `tests/e2e/**`
- `.github/workflows/staging-smoke.yml` (если потребуется только для совместимости параметров)
- `README.md`
- `docs/deployment-yandex-cloud.md`

## Тест-план

- **Compose build and boot**
- [x] `docker compose config` валиден.
- [x] `docker compose up -d` поднимает stack на чистом окружении без ручной установки `pnpm`.
- [x] `api`, `room-state`, `postgres`, `livekit`, `minio`, `caddy` становятся healthy или reachable по ожидаемым endpoint'ам.

- **Local integration**
- [x] Через compose entrypoint доступны `/health`, `/rooms/demo-room`, `/control-plane`.
- [x] `room-state` websocket path работает для presence smoke.
- [x] `livekit` URL, который выдает `api`, достижим из браузерного runtime.
- [x] `sceneBundleUrl`, указывающий на MinIO/public URL, открывается в runtime без изменения контракта.

- **E2E**
- [x] Перед staging publish проходит локальный `pnpm test:e2e`.
- [x] После staging deploy проходит `pnpm test:e2e:staging`.
- [x] На staging вручную подтверждены room load, selector/navigation, control-plane smoke.

- **Негативные кейсы**
- [ ] При отсутствии обязательных env vars compose stack падает предсказуемо и это видно в логах конкретного сервиса.
- [ ] Если `postgres` не готов, `api` не дает ложный healthy state.
- [ ] Если bucket в MinIO не создан, это проявляется явной ошибкой bootstrap шага, а не тихим runtime fallback.
- [ ] Если staging rollout неуспешен, rollback path восстанавливает предыдущий рабочий контур.
- [ ] При неуспешном staging rollout собираются диагностические артефакты: `docker compose ps`, `docker compose logs --tail=200` по `api`, `room-state`, `caddy`, `minio`.

## Риски и откаты (roll-back)

- Риск: compose-конфиг для staging получится слишком отличным от local и потеряет ценность как единый contract.
  - Откат: держать один базовый compose-файл и минимум staging overrides только для доменов/env/volumes.
- Риск: попытка включить MinIO semantics слишком рано затянет фазу.
  - Откат: оставить MinIO только как infra/bootstrap для public bundle URLs, без полной storage abstraction в `api`.
- Риск: staging cloud-init migration сломает рабочую VM.
  - Откат: поднимать новую staging VM через отдельный compose-oriented cloud-init, не переписывая in-place старую машину.
- Риск: `caddy`/TLS/hostnames в compose-режиме разойдутся с тем, что ожидают `runtime-web` и `api` manifests.
  - Откат: сначала зафиксировать sslip.io-style адреса и существующий доменный шаблон из `staging-scenes.yaml`, не меняя публичный contract.
- Риск: rollback затронет данные `postgres`/`minio`.
  - Откат: rollback ограничить compose/env/image/config слоем; volumes не удалять и не пересоздавать автоматически.

## Definition of done для Phase 2

- [x] Есть compose-based stack для `caddy`, `api`, `room-state`, `livekit`, `postgres`, `minio`.
- [x] Stack локально поднимается одной командой и проходит базовый integration smoke.
- [x] Локально проходит `pnpm test:e2e` после перехода на compose path.
- [x] Staging опубликован через compose-based deploy path.
- [x] После staging rollout проходит `pnpm test:e2e:staging`.
- [x] Для неуспешного rollout есть документированный rollback path, проверенный smoke-проверкой.

## Итог выполнения

- Phase 2 завершена: локальный compose stack, staging publish path, staging smoke, `pnpm test:e2e:staging` и rollback smoke были доведены до рабочего состояния.
- Рабочие compose-артефакты: `infra/docker/compose.staging.yml`, `infra/docker/.env.staging.example`, `infra/docker/Caddyfile.local`, `infra/docker/Caddyfile.staging`, `infra/docker/minio-bootstrap.sh`, `infra/yandex/cloud-init/staging-compose.yaml`, `infra/yandex/scripts/provision-staging-compose.sh`.
- Финальный проверенный compose staging host после фазы: `noah-stage-compose-v11` (`89.169.161.91`) с публичным app URL `https://89.169.161.91.sslip.io` и прямым smoke fallback через `http://<ip>:4000`.
- Для staging e2e подтвердился рабочий запуск через `BASE_URL=http://<ip>:4000 PLAYWRIGHT_NO_WEB_SERVER=1 pnpm test:e2e:staging`.
- Отдельно подтверждены scene-room проверки для `Hall` и `BlueOffice`; для `BlueOffice` нужно ждать диагностики дольше, чем для простых комнат.
- Важные инфраструктурные инсайты: cloud-init должен создавать реального SSH user с `ssh_authorized_keys`, MinIO image на staging надежнее тянуть с Docker Hub (`minio/minio`), а sslip-домены должны строиться напрямую от IP (`${ip}.sslip.io`, `state.${ip}.sslip.io`, `livekit.${ip}.sslip.io`).
