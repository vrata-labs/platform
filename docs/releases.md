# Releases

Vrata uses SemVer: `MAJOR.MINOR.PATCH`.

## Version Policy

- Public release tags use `vX.Y.Z`, for example `v0.1.0`.
- Docker image tags use both SemVer and immutable git SHA tags.
- `latest` is not a documented upgrade target.
- Until `1.0.0`, minor releases may contain breaking changes, but they must be documented in `CHANGELOG.md` and `docs/upgrades.md`.

## Release Artifacts

Each public release should include:

- GitHub Release notes;
- source archive from the tag;
- `CHANGELOG.md` entry;
- GHCR images for `api`, `room-state`, and `remote-browser`;
- image tags for SemVer and git SHA;
- known limitations;
- upgrade and rollback notes.

Public Docker images are published by `.github/workflows/docker-release.yml` to GHCR when a `v*` tag is pushed or when the workflow is manually dispatched for a release candidate.

The workflow intentionally fails if root `LICENSE` is missing, because public release images must not be published before the code license is explicit. Asset audit must still be complete before a public `v0.1.0` release.

The workflow also runs `tools/check-public-assets.mjs`; it fails if non-cleared scene bundles are included in the public runtime assets directory.

## Приватные scene releases и внутренний staging

Их выпуск независим от публичного SemVer-релиза платформы:

1. Зафиксировать согласованный source commit в приватном GitVerse
   `vrata-labs/vrata-scene-assets-private`; сохранять provenance восстановленного
   снимка и ограничения прав. Не выдавать новый root за полную прежнюю историю.
2. Выполнить `tools/private-scene-release.py pack` без переэкспорта моделей.
   Отдельный writer публикует полный пакет в приватный S3 через AWS CLI `1.46.0`:
   conditional PUT архива, read-back, затем immutable descriptor.
   Положительные PUT/GET, повтор тех же bytes и reader fetch обязательны;
   одни отказы anonymous/reader write не подтверждают готовность.
3. Закрепить новый пакет в `infra/docker/private-scene-release.lock.json` по
   фактическим descriptor/archive/inventory bytes, размерам и SHA-256.
   `assetSha` — source Git SHA, не platform SHA и не archive SHA-256.
   Endpoint/region/bucket — environment configuration, credentials в lock не входят.
4. Проверить узкий platform diff, release/recovery/rollout tests, полные локальные
   lint/typecheck/build/unit и штатный e2e. Поставить workflow/helper/lock обычным PR
   в default `main` с обязательными проверками и review, без обхода защиты.
   Существование изменений только в feature-ветке не меняет workflow bootstrap.
5. После зелёных CI/Docker Publish точного кандидата взять `vrata-stage` lease.
   Bootstrap отсутствующего стенда запускается из `main`, получает пакет только
   reader-ключом и проходит gate; затем gated catalog activation выполняет полный
   staging-набор. При существующем binding сохраняется его `assetSha`, даже если
   новый lock указывает на другой релиз.
6. На exact deployed SHA проверить accepted record, каталог сцен, полный staging
   gate и `pnpm test:e2e:staging-extended` вокруг bootstrap/необратимой активации.
   Обновить приватный recovery inventory current/previous/Wave 2/room URLs,
   проверить off-host backup и byte-only restore; освободить аренду.

Reader ограничен GET, writer — GET/PUT в `private-scenes/releases/*`, без DELETE/list.
GitVerse token/deploy key не используются деплоем; S3 secrets остаются только в
fetch step runner. Private scene bytes не попадают в публичные Git, CI artifacts,
source archives и Docker layers. Публичный `scene-repositories.lock.json` остаётся
отдельным контрактом разрешённых сцен.

До acceptance ошибка gate возвращает предыдущие images/snapshot/room URLs;
ошибка S3 до rollout не меняет их. После atomic accepted JSON требуется repair
метаданных, не откат контейнеров с сохранением новой accepted-записи.
Предыдущие S3 releases и verified backup snapshots сохраняются. Недоступная
историческая identity блокирует восстановление; новый source нельзя переименовать
в старый binding или вернуть private Git checkout как fallback.
Byte restore не создаёт designation/gate proof и не принимает новый хост.

Точные команды и входы: [приватные сцены](scene-assets-repository.md),
[CI/CD](ci-cd.md), [staging](deployment-staging.md),
[backup/restore](backup-restore.md).

## Release Checklist

- [ ] Phase 0 safety gate is complete: secret scan, license audit, asset audit.
- [ ] Public repository history exposure is resolved, or the release is cut from a clean public mirror without proprietary scene blobs.
- [ ] `LICENSE` exists at repository root.
- [ ] `CHANGELOG.md` is updated.
- [ ] CI is green on `main`.
- [ ] Internal staging gate is green for the release commit.
- [ ] Self-host compose config check passes.
- [ ] Self-host smoke passes from a clean clone or clean Docker environment.
- [ ] The four-person private public demo follows [`docs/demo/README.md`](demo/README.md), with separate human voice/visual acceptance and cleanup evidence when included in release scope.
- [ ] GHCR images are published with SemVer and SHA tags.
- [ ] Upgrade rehearsal passes.
- [ ] Rollback rehearsal passes.
- [ ] GitHub Release is created from the SemVer tag.

## First Public Beta

The first public beta target is `v0.1.0`. It must be labeled as beta and include known limitations.

If an `0.1.0` release is broken after publication, publish a patch such as `v0.1.1` and mark the broken release as deprecated. Do not rely on deleting tags or images as the public rollback mechanism.
