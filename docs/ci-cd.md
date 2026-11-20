# CI/CD Operations

Vrata keeps test and deployment automation in the repository and executes it in GitHub Actions.

## Source Of Truth

- Workflow definitions: `.github/workflows/`.
- Test specs: `tests/e2e/`, `apps/**`, `packages/**`, and `tools/*.test.mjs`.
- Test contract: `docs/testing-checklist.md`.
- Self-host deployment contract: `infra/docker/compose.selfhost.yml` and `docs/self-hosting.md`.
- Internal staging rollout contract: `.github/workflows/staging-deploy.yml` and `infra/docker/rollout-staging-images.sh`.
- Private scene asset tests are tagged `@private-assets` and are not part of public platform CI.
- Приватный GitVerse `vrata-labs/vrata-scene-assets-private` хранит восстановленные исходники; готовые релизы для Staging Deploy берутся из приватного S3, не из Git checkout.
- `tools/private-scene-release.py fetch` проверяет pinned descriptor/archive/inventory и передаёт `assets/` на хост прежним SSH-путём. GitVerse token и `PRIVATE_SCENE_ASSETS_DEPLOY_KEY` деплою не нужны.
- `scene-repositories.lock.json` и asset-validation публичных сцен независимы от этого приватного release lock.

## GitHub Actions Roles

- `CI`: required PR/push verification.
- `Docker Publish`: internal YCR image publishing for staging.
- YCR staging builds explicitly disable embedded provenance/SBOM attestations because YCR rejects the resulting OCI manifest list. Source and revision remain bound through OCI labels; public GHCR release attestations are a separate release concern.
- `Staging Deploy`: internal staging deploy and verification gate with rollback.
- `Staging Smoke`: manual staging verification utility.
- `Staging Template Catalog`: gated activation/verification каталога на принятом image SHA; не клонирует приватный репозиторий сцен.
- `Docker Release`: public GHCR image publishing for SemVer tags and release candidates.

## Приватные сцены в Staging Deploy

- В repository variables задать `VRATA_SCENES_S3_ENDPOINT`, `VRATA_SCENES_S3_REGION`,
  `VRATA_SCENES_S3_BUCKET`. Текущие defaults: `https://s3.ru-3.storage.selcloud.ru`,
  `ru-3`, `vrata-private-scene-releases`. Это отдельный внешний S3, не Compose
  `minio`/SeaweedFS и не хранилище плагинов.
- Только fetch step получает CI secrets `PRIVATE_SCENES_S3_READER_ACCESS_KEY_ID`
  и `PRIVATE_SCENES_S3_READER_SECRET_ACCESS_KEY`, передаваемые как AWS env.
  Reader имеет GET только на `private-scenes/releases/*`; writer GET/PUT нужен
  отдельному выпуску пакета и в deployment workflow не передаётся. DELETE/list
  и policy/IAM permissions не нужны. До запуска подтвердить положительное чтение
  опубликованного пакета; существование lock или одни ответы 403 этого не доказывают.
- Workflow устанавливает AWS CLI `1.46.0` в отдельный venv. Helper использует
  стандартный S3 API, HTTPS, `--addressing-style path` и конечные deadlines,
  не AWS profiles или credentials хоста.
- До `Sync workspace to deploy SHA` сохраняются fetch helper и catalog версии
  workflow в отдельном `RUNNER_TEMP` рядом с rollback helpers, но вне их host archive.
  При старом target без этих файлов запускается сохранённый helper с `--catalog`.
- Read-only host preflight выполняется bootstrap-installed helper до отправки
  нового протокола/source. Если у target image есть binding, он имеет приоритет:
  fetch получает `--asset-sha`; иначе нужен строгий
  `infra/docker/private-scene-release.lock.json` целевого checkout. Lock не
  сохраняется вместе с helper и не подменяет историческую identity.
- Отказ S3, отсутствующий исторический descriptor, неверные bytes или неполный
  каталог останавливают job до rollout. Fallback на другой release/Git отсутствует.
  После успешного fetch действуют прежние operation lock, snapshot, gate,
  atomic acceptance и rollback; S3 credentials не передаются хосту или браузеру.

Новый стенд создаётся только после обычной поставки этого workflow/helper/lock в
default `main` и успешных CI/Docker Publish точного кандидата: `vrata-stage`
запускает bootstrap из `main`, не из произвольной feature-ветки.
Инфраструктурный PR не должен включать посторонние runtime-изменения или обходить
обязательные проверки/review. Порядок выпуска пакета и ограничения публикации:
[сцены](scene-assets-repository.md), [staging](deployment-staging.md),
[релизы](releases.md).

## Where Results Are Stored

- Workflow logs and summaries are stored in GitHub Actions runs.
- Playwright HTML/JSON/failure artifacts are uploaded to each relevant workflow run.
- Authoritative staging release metadata lives outside checkout at `/opt/vrata-stage-state/accepted-release.json`; the successful SHA marker is derived compatibility metadata.
- Private scenes are pinned by image/asset SHA in immutable host snapshots. The active pointer and accepted/previous/baseline retention are described in `docs/deployment-staging.md`.
- Local full staging e2e and Rutube commands load `.env.staging.local`; populate it with `pnpm staging:e2e:pull-env -- --ssh <user>@<current-staging-ip>` or set the explicit current host URL and admin token.
- Release notes and changelog live in GitHub Releases and `CHANGELOG.md`.
- Compose backup manifests and local rollback env snapshots are written under `backups/` and must stay out of git.

## Environments

- Local developer environment: runs source-built tests and non-staging e2e.
- Internal staging: current managed validation host for deployed commits.
- Public self-host: target user deployment path for `v0.1.0`.

## Policy

- Do not treat local tests as staging verification for runtime/deploy changes.
- Do not run `pnpm test:e2e:staging` as validation of a new change before that exact commit is deployed.
- Do not publish public GHCR release images before the code license, asset audit, and release gate are complete.
- Do not make public CI depend on private `sense-*` scene assets; use `pnpm test:e2e:private-assets` in private asset/staging contexts only.
- Do not add private scene assets back to public release images; private S3 fetch and local private-assets sync must stay outside public release workflows and public CI artifacts.
- Keep artifacts short-lived and avoid writing secrets to browser-visible output.
- Keep `provenance: false` and `sbom: false` explicit on every YCR build step, and read every SHA/branch/staging tag back with `docker buildx imagetools inspect` before reporting publish success.
- Run `pnpm backup:compose` before self-host minor upgrades, validate the manifest, and use `pnpm rollback:compose` instead of `docker compose down -v` when reverting image tags.
