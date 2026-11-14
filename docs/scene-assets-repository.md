# Приватные сцены: исходники и готовые релизы

Публичный репозиторий платформы содержит runtime, API, инфраструктуру, контракты,
валидаторы и разрешённые к распространению примеры. Приватные и клиентские сцены
хранятся отдельно: права на код платформы не дают прав на модели SenseTower.

## Исходный снимок в GitVerse

Приватный репозиторий: `https://gitverse.ru/vrata-labs/vrata-scene-assets-private`.
Это восстановленный снимок прежнего `psilon2000/noah-scene-assets-private`, а не
полная восстановленная история. Новый root-коммит
`ed0c972cf05f512c35861ef76cff8f87080f3133` сохраняет файлы снимка
`0a3b492e788bad82bf20a92476a628bf30c6dfbe`; происхождение и shallow-граница
описаны в `RECOVERY.md`. Исходная копия и её защищённый архив сохраняются отдельно.

```text
assets/
  manifest.json
  scenes/
    sense-hall2-v1/scene.json
    sense-hall2-v1/scene.glb
    ...
README.md
LICENSES.md
RECOVERY.md
```

В репозитории сцен сохраняются происхождение, ограничения распространения,
исходные проекты/команды экспорта, состояние проверки и предполагаемые привязки
комнат. Сохранение legacy-файлов не означает исправления их материалов или текстур.
Перенос готовых релизов не переэкспортирует модели и не создаёт новую визуальную приёмку.

## Закреплённый релиз в S3

GitVerse нужен для хранения и развития исходников. Staging Deploy не клонирует
репозиторий сцен: он получает готовый приватный пакет через стандартный S3 API
и AWS CLI. GitVerse token и прежний `PRIVATE_SCENE_ASSETS_DEPLOY_KEY` этому пути не нужны.

`tools/private-scene-release.py` предоставляет `pack`, `publish`, `fetch`.
Упаковка включает всё существующее `assets/`, без `.git`, credentials и посторонних
каталогов; исходные GLB/GLTF/FBX и `scene.json` не переписываются.

- `assetSha` — полный 40-символьный Git SHA исходников сцен, не SHA платформы.
- `inventory.json` фиксирует относительный путь, размер и SHA-256 каждого файла.
- Детерминированный `bundle.tar.gz` содержит `assets/` и inventory.
- Descriptor: `private-scenes/releases/<assetSha>/release.json`.
- Архив: `private-scenes/releases/<assetSha>/<archiveSha256>/bundle.tar.gz`.
- Descriptor format 1 закрепляет archive/inventory, размеры, SHA-256, список сцен
  и provenance. SHA-256 имеет 64 hex-символа; S3 ETag его не заменяет.
- `infra/docker/private-scene-release.lock.json` закрепляет также точные bytes/SHA-256
  descriptor для нового кандидата. Endpoint, бакет и секреты в lock не входят.

Архив публикуется первым, descriptor — последним. Запись использует
`PutObject If-None-Match: *` и полное контрольное чтение: те же bytes допускают
повтор, иное содержимое под тем же ID отклоняется. Если endpoint не поддерживает
условную запись, публикация останавливается, а не переходит к перезаписи.
Versioning не заменяет эту проверку; автоматическое удаление релизов не предусмотрено.

## Настройки и права

| Вход | Назначение / текущая настройка |
| --- | --- |
| `VRATA_SCENES_S3_ENDPOINT` | HTTPS endpoint: `https://s3.ru-3.storage.selcloud.ru` |
| `VRATA_SCENES_S3_REGION` | S3-пул `ru-3`, не зона сервера `ru-2c` |
| `VRATA_SCENES_S3_BUCKET` | Приватный `vrata-private-scene-releases` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Только защищённое окружение команды publish/fetch |
| `PRIVATE_SCENES_S3_READER_ACCESS_KEY_ID`, `PRIVATE_SCENES_S3_READER_SECRET_ACCESS_KEY` | CI secrets только fetch-шага Staging Deploy |

Workflow читает `VRATA_SCENES_S3_*` из одноимённых repository variables с указанными
значениями по умолчанию. CLI принимает их через env или `--endpoint/--region/--bucket`.
Используется изолированный AWS CLI `1.46.0`; helper не использует AWS profiles,
metadata credentials или Keystone-токен Selectel и не меняет политики бакета.
Для текущего endpoint workflow задаёт `--addressing-style path`; CLI по умолчанию
использует `virtual`. Для отдельного CLI его следует указывать явно.

- Writer: только `s3:GetObject` и `s3:PutObject` в `private-scenes/releases/*`.
- Reader: только `s3:GetObject` в том же префиксе.
- Обычному деплою не нужны PUT, DELETE, ListBucket, права IAM или управления policy.
- Анонимные GET/list и reader PUT/DELETE должны быть запрещены. При этом одни
  отрицательные отказы не подтверждают готовность: нужны успешные writer PUT/read-back
  и reader fetch с проверкой всех хешей.
- Ключи не передаются staging-хосту, браузеру, образам или публичным артефактам CI.
  В URL, descriptor и lock их быть не должно.

## Выпуск и проверка пакета

Команды выполняются из корня платформы. `PRIVATE_SOURCE` — отдельный Git checkout
сцен на полном согласованном commit; `PRIVATE_PACKAGE` — новый каталог вне него,
с защищённым родителем. Установить AWS CLI указанной версии перед S3-командами.

```bash
umask 077
python3 -B tools/private-scene-release.py pack \
  --source "$PRIVATE_SOURCE" --asset-sha "$ASSET_SHA" --output "$PRIVATE_PACKAGE"
```

После положительной проверки writer-доступа загрузить его ключи в защищённое
окружение и опубликовать пакет:

```bash
python3 -B tools/private-scene-release.py publish \
  --package "$PRIVATE_PACKAGE" --addressing-style path --timeout 300
```

Для нового кандидата сформировать lock по фактическим bytes `release.json`
(key/bytes/SHA-256), его `assetSha`, `archive` и `inventory`. Проверить reader-ключом
скачивание в свежий каталог с существующим защищённым родителем до поставки lock:

```bash
python3 -B tools/private-scene-release.py fetch \
  --lock infra/docker/private-scene-release.lock.json \
  --catalog infra/docker/staging-scene-catalog.json \
  --output "$VERIFIED_SOURCE" --addressing-style path --timeout 300
```

Готовый source появляется атомарно только после проверки descriptor, размера и
SHA-256 архива, безопасной распаковки, полного inventory и 13 обязательных сцен
staging-каталога. Проверяются также лимиты количества/размера файлов и свободное
место. Links, специальные файлы, absolute/`..` paths и дубликаты запрещены.
В результате есть `assets/`, `inventory.json`, `release.json`, но нет Git сцен.
Наличие lock в Git само по себе не подтверждает публикацию пакета в S3.

## Identity при поставке и откате

Сначала read-only preflight получает сохранённый binding `imageSha -> assetSha`.
При его наличии fetch использует только `--asset-sha "$BOUND_ASSET_SHA"`.
Для нового image без binding требуется lock именно целевого platform checkout.
Эти варианты взаимоисключающие; новый lock никогда не заменяет старый binding.

До checkout исторического deploy SHA workflow сохраняет fetch helper и
`staging-scene-catalog.json` из версии workflow в `RUNNER_TEMP`. Каталог передаётся
через `--catalog`; новый lock вместе с helper не копируется. Это позволяет
поставлять старый target без helper/lock, если его binding и точный S3 release доступны.
Исторический descriptor допустим только при доказанном происхождении его bytes;
переименовывать новый пакет в неизвестную старую identity нельзя.

Проверенное `source/assets` передаётся по SSH в прежний
`staging-remote-release.py --source`. Operation lock, immutable snapshots,
atomic active, gate, acceptance, retention и rollback остаются обязательными.
Браузер читает прежние versioned URL платформы, включая `state.<host>`, а не S3;
presigned URLs и S3 CORS для этого не требуются.
Bootstrap запускается только после поставки S3 workflow/helper в default `main`.
Подробности: [staging](deployment-staging.md), [CI/CD](ci-cd.md),
[backup/restore](backup-restore.md), [релизы](releases.md).

### Ошибки не переключают источник

`private_scene_release: <code>` возвращает ненулевой статус без сырых ответов CLI
и секретов. `s3_AccessDenied`/`s3_403`, `s3_NoSuchKey`/`s3_404`,
`s3_timeout`, `s3_connection_failed`, `download_digest_mismatch`,
`release_conflict` и ошибки inventory/архива блокируют новую поставку.
403 без ListBucket не считается доказательством отсутствия объекта.
Не использовать другой SHA, `latest`, новый private `main` или Git checkout как fallback.
Ошибка fetch до rollout не меняет принятые контейнеры, active и room URLs.
Откат после gate использует точную прежнюю связку и сохранённые snapshots;
недоступная историческая версия блокируется явно.

## Локальная проверка и публичная граница

Для `@private-assets` допускается синхронизация проверенных bytes в отдельный
внутренний checkout, не используемый для публичной сборки:

```bash
node tools/sync-private-scene-assets.mjs "$VERIFIED_SOURCE/assets"
pnpm test:e2e:private-assets --workers=1 --retries=0
```

`tools/export-private-scene-assets.mjs` остаётся неразрушающим инструментом
первичного экспорта, а не способом восстановить неизвестную историю.
Обычный CI и публичные images используют только разрешённые примеры и fixtures;
отдельный `scene-repositories.lock.json` публичных сцен не меняется.
`sense-*`, Unity/SenseTower `research/exports*`, private bundles и recovery backups
не добавляются в публичный Git, Docker layers или CI artifacts.
`tools/check-public-assets.mjs` сохраняет роль публичного release guard.
Удаление файлов из HEAD не очищает прежнюю Git-историю от proprietary blobs.
