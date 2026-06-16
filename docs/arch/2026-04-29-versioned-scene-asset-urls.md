# Versioned Scene Asset URLs

## Цель

- Сделать так, чтобы при обновлении scene bundle ресурсов браузер гарантированно подтягивал новую версию без incognito, ручной очистки cache или случайного `?nocache=`.
- Закрепить контракт: изменяемые сцены публикуются по новому versioned URL, а старые URL не перезаписываются на месте.
- Сохранить текущий runtime contract: комната по-прежнему получает конкретный `room.sceneBundleUrl`, а runtime просто загружает этот URL.

## Не-цель

- Не строим полноценный uploader больших GLB/текстур в MinIO/S3, если для текущей задачи достаточно уже существующего static/public staging пути.
- Не делаем автоматическое обновление уже открытой комнаты во время сессии.
- Не удаляем старые blobs физически; текущая политика cleanup остается metadata-only.
- Не меняем формат scene bundle manifest без необходимости.

## Предпосылки и ограничения

- В `apps/api/src/storage.ts` уже есть таблица/модель `scene_bundles` с `bundleId`, `version`, `storageKey`, `publicUrl`, `status`, `isCurrent`.
- В `apps/api/src/index.ts` уже есть API для версий: `POST /api/scene-bundles/:bundleId/versions`, `POST /api/scene-bundles/:bundleId/current`, `POST /api/rooms/:roomId/bind-scene-bundle`.
- Runtime manifest пока доверяет только `room.sceneBundleUrl`; это намеренно оставляем, чтобы не расширять runtime.
- `tools/patch-staging-scene-bundles.mjs` сейчас пишет стабильные URL вида `https://state.<host>/assets/scenes/<scene-id>/scene.json`, поэтому браузер может держать старый `scene.json`/asset.
- Staging Caddy отдает `/assets/scenes/*` из `/srv/runtime-public` без явного cache policy; это не должно быть главным механизмом свежести для изменяемых ресурсов.
- Current staging flow завязан на branch `deploy/scene-bundles-stage-20260328` и GitHub Actions deploy by SHA.

## Подход

Используем существующую модель scene bundle versions и делаем URL версии частью пути:

```text
/assets/scenes/<scene-id>/<version>/scene.json
/assets/scenes/<scene-id>/<version>/scene.glb
```

Для staging `version` должен быть воспроизводимым и уникальным для публикации. Базовый вариант: полный git SHA деплоимого commit. Короткие SHA не используем в pipeline, чтобы не создавать неоднозначность.

Первая итерация не меняет исходные scene bundle файлы вручную. На deploy отдельный script создает versioned snapshot: `apps/runtime-web/public/assets/scenes/<scene-id>/` -> `apps/runtime-web/public/assets/scenes/<scene-id>/<DEPLOY_SHA>/` внутри checkout перед build/publish. Комнаты патчатся только после успешной проверки, что versioned `scene.json` и все относительные assets доступны на `state.<host>`.

Внутри `scene.json` asset paths остаются относительными (`scene.glb`, texture paths), поэтому `resolveSceneAssetUrl(response.url, manifest.glbPath)` автоматически поведет GLB/текстуры в ту же versioned directory.

Комнаты привязываются к конкретной версии через `room.sceneBundleUrl`. Переключение текущей версии bundle metadata не меняет уже привязанные комнаты, пока их явно не rebound/patch. Это сохраняет откат простым: вернуть room на предыдущий URL.

## Задачи

- [ ] Зафиксировать canonical storage layout для новых scene versions: `assets/scenes/<scene-id>/<version>/scene.json` и соседние assets.
- [ ] Добавить publish/snapshot script, который для выбранных scenes создает versioned directory `<scene-id>/<full-git-sha>/` со всем содержимым текущей scene directory.
- [ ] В deploy workflow выполнить snapshot до publish/patch шага, чтобы versioned assets физически попали в runtime-public assets.
- [ ] Добавить pre-patch проверку: `scene.json` доступен, `glbPath` резолвится относительно versioned URL и GLB доступен.
- [ ] Обновить staging patch helper `tools/patch-staging-scene-bundles.mjs`, чтобы он принимал `STAGING_SCENE_BUNDLE_VERSION` или deploy SHA и писал versioned URL вместо стабильного `/scene.json`.
- [ ] Обновить `.github/workflows/staging-deploy.yml`, чтобы при patch step передавался exact deployed SHA как scene bundle version.
- [ ] Добавить защиту в helper: если version не задан, он должен явно падать или использовать только осознанный fallback для local/dev, чтобы staging случайно не вернулся к mutable URL.
- [ ] Добавить или обновить tests для helper URL generation: ожидается `/assets/scenes/<scene-id>/<version>/scene.json`.
- [ ] Обновить staging e2e expectations в `tests/e2e/runtime-staging.spec.ts`, чтобы Hall/BlueOffice ожидали versioned URL или проверяли suffix с учетом `STAGING_SCENE_BUNDLE_VERSION`.
- [ ] Добавить API/storage тест, который показывает, что две версии одного bundle имеют разные `publicUrl`, а bind конкретной версии пишет именно versioned URL в room manifest.
- [ ] Обновить README staging notes: больше не патчить комнаты на mutable `/assets/scenes/<scene-id>/scene.json`; использовать versioned URL.
- [ ] Для staging static assets проверить, что versioned files реально доступны через `https://state.<host>/assets/scenes/<scene-id>/<version>/scene.json` и GLB по относительному пути.
- [ ] Если включаем immutable headers для versioned assets, оставить legacy mutable paths совместимыми и не делать их единственным механизмом свежести.
- [ ] На время перехода сохранить backward compatibility: существующие комнаты со старым mutable URL продолжают грузиться, но новый helper/pipeline их больше не создает.
- [ ] После deploy проверить, что обычный браузер без incognito получает новый `sceneBundleUrl` после смены версии.

## Затронутые файлы/модули

- `tools/patch-staging-scene-bundles.mjs` - генерация staging scene bundle URL.
- `.github/workflows/staging-deploy.yml` - передача deploy SHA/version в helper.
- `tests/e2e/runtime-staging.spec.ts` - ожидания URL scene bundles на staging.
- `apps/api/src/index.test.ts` - unit/integration проверки версии и bind flow.
- `README.md` - staging workflow и предупреждение про mutable URL.
- `infra/docker/Caddyfile.staging` - только если понадобится явно выставить cache headers для immutable versioned paths.
- `apps/runtime-web/public/assets/scenes/**` - layout новых scene bundle версий.

## Тест-план

### Unit / Integration

- [ ] `pnpm --filter @vrata/api test`: проверить scene bundle versions, conflict handling, bind конкретной версии и manifest URL.
- [ ] Тест helper URL generation: для `sceneId=sense-hall2-v1`, `version=<sha>` ожидается `https://state.<host>/assets/scenes/sense-hall2-v1/<sha>/scene.json`.
- [ ] Негативный тест helper: staging mode без version не должен молча писать mutable URL.

### Runtime / E2E Local

- [ ] `pnpm test:e2e`: убедиться, что runtime по-прежнему загружает scene bundles из `room.sceneBundleUrl`.
- [ ] Добавить/обновить e2e, где manifest URL содержит versioned directory, а `scene.glb` резолвится относительно нее.

### Staging

- [ ] После push/deploy проверить `GET /api/rooms/<hall>/manifest`: `sceneBundle.url` содержит новую versioned directory.
- [ ] Проверить `GET https://state.<host>/assets/scenes/<scene-id>/<version>/scene.json` и GLB рядом с ним.
- [ ] Запустить `pnpm test:e2e:staging`.
- [ ] Открыть Hall в обычном браузере, не incognito, после повторного обновления scene version и убедиться, что подтянулась новая версия.
- [ ] Проверить rollback: привязать room к предыдущему versioned URL и убедиться, что сцена снова грузится.

### Негативные Кейсы

- [ ] Missing versioned `scene.json` возвращает понятный staging failure, а не silently old scene.
- [ ] Missing relative GLB внутри versioned directory приводит к `sceneDebug.state=failed` с `failed_to_load_scene_asset`.
- [ ] Попытка создать duplicate `bundleId + version` возвращает `scene_bundle_version_conflict`.
- [ ] Старый mutable URL продолжает работать для существующих комнат до миграции.

## Риски и откаты

- Риск: staging helper начнет писать URL на директорию, которой нет в опубликованных assets.
  Откат: helper не должен patch room при failed preflight; если проблема уже попала на staging, вернуть `STAGING_SCENE_BUNDLE_VERSION` на предыдущий существующий version или временно patch room на старый known-good URL.

- Риск: e2e tests станут слишком жестко завязаны на конкретный SHA.
  Откат: передавать ожидаемый version через env и проверять URL pattern, а не hardcode SHA.

- Риск: накопление старых scene versions увеличит размер runtime-public/staging assets.
  Откат: использовать существующие `obsolete` / `cleanup-ready` metadata statuses и отдельный ручной cleanup позже; физическое удаление не входит в этот план.

- Риск: часть комнат останется на старых mutable URL и продолжит ловить cache ambiguity.
  Откат/миграция: отдельным списком пройти staging scene rooms и patch/bind их на versioned URLs после проверки Hall/BlueOffice.

- Риск: если GLB перезаписывать внутри той же versioned directory, cache снова станет неоднозначным.
  Митигирующее правило: versioned directory immutable после публикации; любое изменение scene.json/GLB/texture требует нового version.

- Риск: rollback указывает на versioned URL, assets которого уже удалены.
  Митигирующее правило: перед rollback проверять доступность предыдущего `scene.json` и его относительного GLB; физическое удаление старых versions не автоматизировать в этой итерации.

## Критерии готовности

- Новый staging deploy пишет Hall/BlueOffice на URL с versioned directory.
- Versioned directory физически существует на `state.<host>` до patch room.
- Patch helper не меняет room URL, если versioned scene assets недоступны.
- Обычный браузер после смены scene version видит новую сцену без incognito/clear cache.
- Старые rooms со старым URL не ломаются.
- `pnpm --filter @vrata/api test`, `pnpm test:e2e`, `pnpm test:e2e:staging` проходят.
- README описывает новый workflow и явно запрещает mutable overwrite как нормальный путь публикации.
