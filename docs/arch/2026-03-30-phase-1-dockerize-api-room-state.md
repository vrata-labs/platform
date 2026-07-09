# План: Phase 1 — dockerize `api` и `room-state`

## Цель

Подготовить `apps/api` и `apps/room-state` к воспроизводимому запуску в production-like Docker-образах без зависимости от локального `node`/`pnpm` окружения на целевой VM. Результат фазы — два рабочих образа, понятные healthchecks и локальная проверка, что контейнеры стартуют корректно.

## Не-цель

- Не переводить staging на `docker compose` в рамках этой фазы.
- Не внедрять `MinIO`, `Yandex Object Storage` или storage abstraction в рамках этой фазы.
- Не настраивать CI/CD deploy pipeline и публикацию образов в registry в рамках этой фазы.
- Не переносить `caddy`, `postgres`, `livekit` в новый compose stack сейчас.
- Не делать полный self-hosted one-click deployment; это следующая фаза.

## Предпосылки и ограничения

- `apps/api` уже является главным backend entrypoint и должен продолжить раздавать `runtime-web` и `control-plane` статику.
- `apps/runtime-web` и `apps/control-plane` уже собираются в `dist` и логично включаются в `api` image на build stage.
- `apps/room-state` уже имеет отдельный `/health` endpoint и отдельный runtime process.
- В репозитории уже есть локальный docker-файл для зависимостей: `infra/docker/docker-compose.local.yml` с `postgres` и `livekit`; это полезный ориентир, но не целевая реализация Phase 1.
- `api` и `room-state` должны запускаться в контейнерах независимо от локально установленного `pnpm` на VM.
- Нужно минимизировать размер образов и не тащить в них `research/`, лишние сцены, локальные артефакты тестов и git metadata.
- В текущем коде health path уже есть: `apps/api/src/index.ts` и `apps/room-state/src/index.ts`.
- Для smoke-проверки нужно заранее зафиксировать минимальный обязательный набор env vars для `api` и `room-state` контейнеров.

## Подход

Сделать две изолированные production-сборки через multi-stage Docker build:

1. Builder stage устанавливает workspace dependencies и собирает только нужные пакеты.
2. Runtime stage содержит только production-зависимости, собранный JS output и минимально необходимые static assets.
3. `api` image дополнительно включает собранные `apps/runtime-web/dist` и `apps/control-plane/dist`.
4. Проверка фазы выполняется локальным запуском контейнеров с явными env vars и healthcheck smoke, без перехода на compose deploy.
5. В Phase 1 используется один согласованный стиль размещения Dockerfile: по одному Dockerfile рядом с приложением в `apps/api` и `apps/room-state`.

## Задачи

### Подготовка Docker context

- [x] Зафиксировать, какие workspace файлы реально нужны для сборки `api` и `room-state`: root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, app `package.json`, shared packages, `tsconfig*`.
- [x] Зафиксировать минимальный набор env vars для локального smoke запуска `api` и `room-state` контейнеров.
- [x] Добавить корневой `.dockerignore`, который исключает `.git`, `node_modules`, `dist`, `test-results`, `.turbo`, `.next`, `research/` и прочие тяжелые локальные артефакты.
- [x] Проверить, что `.dockerignore` не вырезает нужные runtime public assets и scene bundles, которые действительно должны попасть в `api` image.

### Dockerize `apps/api`

- [x] Добавить production Dockerfile для `apps/api` с multi-stage build.
- [x] В builder stage собирать `apps/api`, `apps/runtime-web`, `apps/control-plane` и нужные shared packages.
- [x] В runtime stage копировать только минимально необходимое: `apps/api/dist`, `apps/runtime-web/dist`, `apps/runtime-web/public` если нужно для asset fallback, `apps/control-plane/dist`, package metadata и runtime deps.
- [x] Зафиксировать `CMD`/`ENTRYPOINT` для запуска `apps/api/dist/index.js`.
- [x] Добавить `HEALTHCHECK`, опирающийся на `GET /health`.
- [x] Проверить, что `api` image стартует с обязательными env vars и отдает `/health`, `/rooms/demo-room` и `/control-plane`.

### Dockerize `apps/room-state`

- [x] Добавить production Dockerfile для `apps/room-state` с multi-stage build.
- [x] В builder stage собирать `apps/room-state` и минимально необходимые shared зависимости.
- [x] В runtime stage копировать только нужный build output и runtime deps.
- [x] Зафиксировать `CMD`/`ENTRYPOINT` для запуска `apps/room-state/dist/index.js`.
- [x] Добавить `HEALTHCHECK`, опирающийся на `GET /health`.
- [x] Проверить, что `room-state` image стартует локально и отвечает health endpoint без локального `pnpm`.

### Локальная smoke-проверка фазы

- [x] Собрать оба образа локально из чистого docker context.
- [x] Запустить `room-state` контейнер локально с тестовым портом и убедиться, что `/health` зеленый.
- [x] Запустить `api` контейнер локально с тестовыми env vars и убедиться, что `/health` зеленый.
- [x] Проверить, что `api` контейнер отдает room manifest и статику `runtime-web`/`control-plane`.
- [x] Проверить, что процессы в контейнерах корректно завершаются по `SIGTERM` без зависания.
- [x] Зафиксировать короткие команды сборки/запуска в документации или comments рядом с Dockerfile не добавляя лишнюю операционную сложность.

## Затронутые файлы/модули

- `apps/api/**`
- `apps/room-state/**`
- `apps/runtime-web/**`
- `apps/control-plane/**`
- `packages/**` (только если нужны shared runtime deps/build deps)
- `.dockerignore`
- `Dockerfile` в корне или `apps/api/Dockerfile`
- `apps/room-state/Dockerfile` или эквивалентный путь
- `README.md` или `docs/` с краткой инструкцией локального контейнерного smoke

## Тест-план

- **Build**
- [x] `docker build` для `api` проходит из чистого контекста.
- [x] `docker build` для `room-state` проходит из чистого контекста.

- **Smoke runtime**
- [x] `api` контейнер отвечает на `/health`.
- [x] `room-state` контейнер отвечает на `/health`.
- [x] `api` контейнер отдает `/rooms/demo-room`.
- [x] `api` контейнер отдает `/control-plane`.

- **Integration-lite**
- [x] `api` image включает собранные `runtime-web` и `control-plane` assets.
- [x] `api` image не зависит от локального `pnpm`/workspace на хосте после сборки.
- [x] `room-state` image не зависит от локального `pnpm`/workspace на хосте после сборки.

- **Негативные кейсы**
- [x] При пропуске обязательных env vars контейнер падает предсказуемо или явно сигнализирует о неверной конфигурации.
- [x] `HEALTHCHECK` не показывает false green до реального старта процесса.
- [x] `.dockerignore` не ломает сборку исключением обязательных файлов.

## Риски и откаты (roll-back)

- Риск: multi-stage Dockerfile для `api` получится слишком связанным со всем workspace.
  - Откат: сначала принять чуть более широкий build context, а затем ужимать image и copy set отдельным шагом.
- Риск: `api` image случайно перестанет отдавать нужные static assets из-за неполного copy набора.
  - Откат: явно включить `apps/runtime-web/dist`, `apps/runtime-web/public` и `apps/control-plane/dist`, затем минимизировать только после smoke-проверки.
- Риск: `.dockerignore` исключит нужные scene/public assets.
  - Откат: исключать только очевидно тяжелые директории (`research/`, `node_modules`, `test-results`) и отдельно проверить asset fallback path.
- Риск: попытка сразу оптимизировать image size замедлит фазу.
  - Откат: сначала добиться рабочих образов, затем делать size pass отдельным follow-up.

## Definition of done

- [x] Есть production Dockerfile для `apps/api`.
- [x] Есть production Dockerfile для `apps/room-state`.
- [x] Есть корневой `.dockerignore`, не ломающий build.
- [x] `api` image локально стартует и отвечает на `/health`.
- [x] `room-state` image локально стартует и отвечает на `/health`.
- [x] `api` image отдает `runtime-web` и `control-plane` статику.
- [x] Для запуска контейнеров не требуется локальный `pnpm` на целевой VM после сборки образов.
