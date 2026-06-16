# План: Phase 4 — CI для тестов и сборки/публикации образов

## Цель

Собрать воспроизводимый GitHub Actions pipeline для `noah`, который на изменениях в репозитории прогоняет основной набор проверок, собирает Docker-образы `api` и `room-state`, публикует их в registry с immutable SHA tags и удобными alias tags, но не делает auto-deploy на staging.

## Не-цель

- Не делать auto-deploy на staging по SSH; это остается следующей фазой.
- Не внедрять production deploy.
- Не переводить staging VM на `docker compose pull` в рамках этой фазы.
- Не менять runtime/staging contract, compose topology или storage abstraction, если это не нужно для CI build/push.
- Не делать сложный multi-env release orchestration, matrix по нескольким registry или promotion pipeline.

## Предпосылки и ограничения

- Phase 1-3 уже завершены: Dockerfiles существуют, compose staging работает, Phase 3 storage flow работает и staging e2e зеленые.
- В репозитории уже есть `.github/workflows/ci.yml` и `.github/workflows/staging-smoke.yml`; Phase 4 должна расширять существующие patterns, а не заводить хаотичный новый CI слой.
- Текущий staging deploy path пока build-based на VM; registry publish нужен как подготовка к следующей фазе, а не как немедленный deploy switch.
- Целевой registry для этой фазы — `Yandex Container Registry`; image naming и auth contract должны быть зафиксированы именно под него.
- Пользовательский приоритет сейчас — прагматичный pipeline: простой, предсказуемый, без лишней магии.
- Обязательные проверки в этой фазе должны оставаться неинтерактивными и воспроизводимыми в CI.
- Registry должен использовать immutable SHA tags как source of truth; alias tags (`staging`, branch tag) допустимы только как вспомогательные.

## Подход

Расширить GitHub Actions так, чтобы один основной workflow покрывал install/typecheck/tests и отдельно собирал/публиковал Docker-образы. PR запускают только CI/test jobs; publish job запускается только на push в рабочую ветку и/или через `workflow_dispatch`, использует buildx + login в `Yandex Container Registry`, публикует `api` и `room-state` по commit SHA и обновляет только ограниченный набор alias tags (`staging`, branch-slug). В этой фазе `latest` не нужен. Никакого deploy шага в этом плане нет.

## Задачи

### 1. Зафиксировать CI/publish contract

- [x] Зафиксировать, какие события запускают test workflow, а какие — image publish workflow.
- [x] Зафиксировать naming для image tags: обязательный immutable tag по `git sha`, optional alias tags (`staging`, branch-slug, `latest` если нужен).
- [x] Зафиксировать target registry и required secrets/auth path для GitHub Actions.
- [x] Зафиксировать точные image names/repositories для `api` и `room-state` в `Yandex Container Registry`.
- [x] Зафиксировать rule: deploy в следующей фазе всегда использует конкретный SHA image tag, а не alias tag.

### 2. Обновить основной CI workflow

- [x] Привести `.github/workflows/ci.yml` к явному набору шагов: checkout, pnpm setup, install, lint/typecheck, package tests, `pnpm test:e2e`.
- [x] Убедиться, что CI использует те же команды, что уже реально работают локально в проекте.
- [x] Зафиксировать cache strategy для `pnpm`, чтобы не усложнять pipeline кастомным caching beyond basics.
- [x] Явно определить, какие jobs обязательны для green CI.
- [x] Зафиксировать, что `pnpm test:e2e` является blocking CI gate на стандартном GitHub runner, либо явно задокументировать отдельный CI profile, если полный e2e окажется слишком тяжелым для default path.

### 3. Добавить Docker build workflow

- [x] Добавить GitHub Actions workflow/job для сборки `apps/api/Dockerfile` и `apps/room-state/Dockerfile`.
- [x] Использовать `docker/setup-buildx-action` и reproducible build path без завязки на локальный хост.
- [x] Проверить, что оба образа собираются из чистого CI context.
- [x] Зафиксировать, нужны ли multi-platform builds сейчас; если нет — оставить одну платформу, чтобы не усложнять Phase 4.

### 4. Добавить registry publish workflow

- [x] Добавить login в выбранный registry через GitHub secrets.
- [x] Публиковать `api` и `room-state` с immutable SHA tags.
- [x] Добавить ограниченный набор alias tags для удобства (`staging`, branch tag), не заменяя SHA tag и не вводя `latest` в этой фазе.
- [x] Явно ограничить publish conditions, чтобы PR из fork/обычные feature branches не пытались пушить без нужных прав.

### 5. Проверить metadata и traceability

- [x] Добавить OCI labels/metadata в publish step: repo, commit SHA, build timestamp.
- [x] Убедиться, что по published tag можно однозначно понять, какой commit собрал образ.
- [x] Зафиксировать output workflow: какие image refs он печатает/экспортирует для следующей фазы deploy.
- [x] Зафиксировать permissions и secrets contract для publish workflow.

### 6. Подготовить handoff к Phase 5

- [x] Добавить короткую инструкцию, как staging deploy будет использовать registry images по SHA в следующей фазе.
- [x] Обновить docs так, чтобы registry/tag contract был понятен без чтения workflow YAML.
- [x] Не менять текущий staging deploy path в этой фазе, только задокументировать planned switch.

## Затронутые файлы/модули

- `.github/workflows/ci.yml`
- `.github/workflows/**` новый build/publish workflow при необходимости
- `apps/api/Dockerfile`
- `apps/room-state/Dockerfile`
- `README.md`
- `docs/deployment-yandex-cloud.md`
- `docs/plans/2026-03-30-docker-compose-minio-cicd-roadmap.md` (если нужно проставить прогресс/ссылки)

## Тест-план

- **CI checks**
- [x] `lint`/`typecheck` проходят в GitHub Actions на чистом runner.
- [x] Package tests проходят в GitHub Actions.
- [x] `pnpm test:e2e` проходит в GitHub Actions или предсказуемо ограничен documented CI profile, если нужен отдельный runner setup.

- **Docker build**
- [x] `api` image собирается в CI из чистого context.
- [x] `room-state` image собирается в CI из чистого context.
- [x] Build logs/outputs явно показывают итоговые image refs.

- **Publish**
- [x] Publish job пушит immutable SHA tags.
- [x] Alias tags обновляются только там, где это разрешено policy.
- [x] Можно вручную проверить, что опубликованные refs доступны в registry.

- **Негативные кейсы**
- [x] При отсутствии registry secrets publish job fail-fast падает понятной ошибкой.
- [x] PR без прав на publish не ломает весь CI и не пытается пушить образы.
- [x] Build failure одного image валит publish stage и не публикует частично битый результат без явного сигнала.
- [x] Теги не перетирают SHA-based traceability.

## Риски и откаты (roll-back)

- Риск: pipeline станет слишком медленным из-за `pnpm test:e2e` + docker build в одном workflow.
  - Откат: разделить test и publish jobs, но оставить один понятный contract и минимальный набор зависимостей между jobs.
- Риск: publish будет случайно триггериться на неподходящих ветках.
  - Откат: ограничить publish по branch filters и/или `workflow_dispatch`.
- Риск: registry/auth на GitHub Actions окажется хрупким.
  - Откат: сначала fail-fast auth validation и ручной publish trigger, прежде чем делать publish default path.
- Риск: alias tags начнут использоваться как deploy source of truth.
  - Откат: явно документировать и проверять, что deploy uses SHA only.

## Definition of done для Phase 4

- [x] GitHub Actions стабильно гоняет основной CI набор: install, lint/typecheck, tests, `pnpm test:e2e`.
- [x] `api` и `room-state` собираются в Docker images на CI runner.
- [x] Образы публикуются в registry по immutable SHA tags.
- [x] Alias tags, если используются, не заменяют SHA tag как deploy source of truth.
- [x] Registry/tag contract задокументирован для следующей фазы staging CD.

## Итог выполнения

- Phase 4 завершена: GitHub Actions workflow для CI и отдельный workflow для build/push Docker images настроены и проверены.
- Live target registry: `Yandex Container Registry` `crp9cm29k6p76hqo8lti` (`noah`).
- Live published image names: `cr.yandex/crp9cm29k6p76hqo8lti/noah-api` и `cr.yandex/crp9cm29k6p76hqo8lti/noah-room-state`.
- Publish workflow уже прошел end-to-end через GitHub Actions и записал immutable SHA tags плюс alias tags `staging` и branch-slug.
