# План: VRATA-FEAT-032 — стандартные шаблоны комнат

Исходное ТЗ: `docs/plans/032-standard-room-templates-personal-meeting-presentation/README.md`.

Срок не задан. План рассчитан на поэтапную поставку и закрывается только после публикации трёх самостоятельных public demo-сцен и проверки на desktop, физических mobile-устройствах и Meta Quest.

## Цель

- Поставить три поддерживаемых reference template: `personal-room-basic`, `meeting-room-basic`, `presentation-room-basic`.
- Сделать `packages/templates` каноническим типизированным реестром встроенных шаблонов для API; control plane, runtime и room-state получают только API DTO, manifest и подписанный room snapshot и не импортируют registry напрямую.
- Закреплять созданную комнату за точной парой `templateId` + `templateVersion`; изменение новой версии шаблона не должно молча менять существующие комнаты.
- Применять defaults шаблона на сервере, чтобы UI и прямой API создавали одинаковую комнату, и сохранять snapshot с неизменяемой version-owned частью и обновляемой проекцией фактических room settings.
- Разрешить редактирование допустимых defaults при создании комнаты, но защищать на API обязательные инварианты personal room и контракт surfaces.
- Поставить для каждого шаблона отдельную оригинальную сцену VRATA публичного demo-качества, а не общий fallback с разными labels.
- Хранить и публиковать каждую новую original scene в отдельном публичном scene-репозитории через immutable version paths; platform repository и общий historical assets repository не являются контейнерами новых сцен.
- Поддержать официальный public asset origin по умолчанию и настраиваемый `ROOM_TEMPLATE_ASSET_BASE_URL` для self-host mirror/offline-поставки.
- Показывать в control plane реальный preview итоговой сцены, назначение шаблона и его версию до создания комнаты.
- Сохранить работоспособность существующих комнат на legacy templates без автоматической миграции.

Критерии готовности:

- `GET /api/templates` по умолчанию возвращает только три активных шаблона с версиями, описаниями, реальными preview URL, defaults и required surfaces;
- новые комнаты нельзя создавать из deprecated templates, но существующие legacy rooms продолжают открываться и редактироваться без смены шаблона;
- API создаёт комнату каждого типа с ожидаемыми settings и immutable scene URL, даже если запрос отправлен без control-plane UI;
- personal room остаётся personal/private/owner-bound, meeting room получает small-group layout и collaboration surfaces, presentation room получает audience layout и presentation surface;
- runtime manifest и diagnostics показывают фактические `templateId`, `templateVersion`, scene reference и surface IDs;
- все три опубликованные сцены достигают `sceneDebug.state=loaded`, имеют `missingAssets=0`, проходят профильные бюджеты и визуальную приёмку;
- personal flow подтверждает private notes/workspace, meeting flow подтверждает 2-4 participants и spatial audio, presentation flow подтверждает PDF page sync и screen share на нужной surface;
- local full e2e, штатные CI/Docker/Staging workflows и `pnpm test:e2e:staging` проходят на одном и том же platform commit;
- отдельные ручные отчёты подтверждают загрузку и ключевой сценарий всех трёх шаблонов на desktop, Android Chrome, iOS Safari и Meta Quest Browser с точными версиями устройств/OS/browser.

## Не-цель

- Не создавать marketplace, tenant-authored template CRUD, drag-and-drop editor или branding studio.
- Не превращать templates в универсальный scene constructor или scripting/plugin API.
- Не переносить private `sense-*`/Unity exports и не использовать их композицию, meshes, textures, trade dress или приватные URLs.
- Не использовать stage-only scene assets как default для публичных шаблонов.
- Не включать scene binaries в platform repository или platform Docker image.
- Не выполнять автоматическую миграцию legacy rooms на новые шаблоны и не добавлять режим `follow latest`.
- Не менять `templateId` или `templateVersion` существующей комнаты в FEAT-032; migration, override provenance и state conversion оформляются отдельной задачей.
- Не менять опубликованную template/scene version на месте; исправление поведения требует новой версии.
- Не переделывать PDF presentation, presenter permissions, screen share, personal room и room creation UI заново: эти возможности уже смержены и используются как зависимости.
- Не добавлять несколько quality-вариантов одной сцены в первой версии, если один bundle укладывается одновременно в обязательные mobile/XR бюджеты.
- Не считать Chromium mobile emulation или synthetic WebXR заменой физическим device checks.

## Предпосылки и ограничения

- Реализацию следует начинать от актуального `origin/main`, а не от долгоживущей deploy-ветки текущего рабочего каталога.
- `VRATA-FEAT-025` фактически завершена: PR `#14`, merge commit `1c9fb60`, CI `29190138064`, Docker Publish `29190138018` и Staging Deploy `29190217732` успешны. Статус старой backlog-карточки не отражает состояние `main`.
- Presenter permissions и screen share также смержены до PDF presentation; FEAT-032 должна интегрировать их, а не дублировать.
- Для `feat/standard-room-templates` найден крупный незакоммиченный прототип: около 70 изменённых файлов и более 7 тысяч добавленных строк. Его нужно восстановить как patch на свежей ветке, разделить по ответственности и повторно проверить; перенос всего diff без ревью не допускается.
- Полезные части прототипа: типизированные metadata, immutable versions, deprecated aliases, server-side defaults, previews, template-aware runtime layout и e2e scenarios.
- Части прототипа, которые требуется пересмотреть: общий fallback вместо трёх сцен, SVG-заглушки preview, широкие изменения session/reconnect/infra и дублирование domain logic в `storage.ts`/`main.ts`.
- `vrata-labs/scene-assets` существует и хранит historical multi-scene compatibility/review releases, но с 2026-08-12 новые original scenes создаются по правилу one-scene-one-repository. Existing releases не мигрируются и не переписываются.
- Scene binaries публикуются отдельно, поэтому platform CI не должен зависеть от mutable branch URL или от доступности приватного репозитория.
- Runtime продолжает доверять только `room.sceneBundleUrl`. Template resolver обязан развернуть относительную scene reference в этот существующий контракт до выдачи manifest.
- Scene Bundle v1 уже поддерживает spawn, bounds, seat anchors и visual-only `mediaSurfaces`. Scene владеет физическими transforms/sizes; template владеет назначением surface и допустимыми media object types.
- Все новые сцены должны соблюдать `docs/scene-technical-requirements.md` и работать без scene-specific runtime patches или broad material overrides.
- Так как обязательны mobile и Quest, каждая сцена должна пройти одновременно hard limits профилей `mobile-lite` и `xr`: bundle/GLB не более 15 MB, не более 90k runtime triangles, 500 objects, 250 meshes, 96 materials, 48 textures и 20 секунд cold load на staging.
- Публичное demo-качество оценивается не только бюджетами: первый кадр должен быть читаемым, назначение комнаты очевидным, surfaces и seats визуально совпадать с interaction anchors.
- Для asset authoring нужно закрепить версию Blender/DCC и экспортного pipeline в каждом scene repository. Исходники, generated outputs и опубликованные bundles должны храниться раздельно внутри boundary одной сцены.
- Создание public scene repositories, настройка их CDN/static origin и physical-device QA требуют доступа владельца organization и устройств. Эти зависимости должны быть подтверждены до начала соответствующего этапа.

Definition of Ready для assets/device этапов:

- Подтверждены имена отдельных scene repositories, права создания public repositories и владелец release credentials.
- Официальный origin выбран как jsDelivr URL по полному commit SHA конкретного scene repository; mutable branch/tag URL не используется в template lock.
- Подтверждены CORS, content types, максимальный размер файла, versioned cache behavior и сохранение Git commit, на который указывает опубликованный release.
- В каждом scene repository есть `platform-validator.lock` с полным platform commit SHA; workflow checkout-ит этот SHA и запускает workspace `@vrata/asset-pipeline`, не предполагая публикацию private package в npm.
- Назначен QA owner и доступны конкретные Android, iOS и Meta Quest устройства; model, OS/browser minimum и дата доступности записаны до начала финального art pass.
- Если любой пункт не выполнен, platform compatibility slice можно выпускать, но product templates остаются неактивными и FEAT-032 не считается завершённой.

Оценка при последовательной работе одного разработчика/technical artist: 32-50 рабочих дней, из них 3-5 дней на аудит и platform contract, 5-8 дней на backend/UI/runtime integration, 6-10 дней на каждую demo-сцену с art/optimization iterations и 3-5 дней на staging/device acceptance. Перечисленные scene tasks покрывают первый проход; в 6-10 дней на сцену отдельно заложен резерв 30-40% на visual review, повторный export и performance rework. При параллельной работе platform-разработчика и 3D-разработчика календарный срок можно сократить примерно до 5-7 недель.

## Подход

### 1. Восстановить и сократить прототип

Создать чистую implementation branch от актуального `origin/main`, экспортировать незакоммиченный FEAT-032 diff как patch и переносить изменения небольшими логическими срезами. Сначала сохранить тесты и pure domain code, затем заново обосновать изменения storage, session tokens, reconnect и deploy scripts. Build artifacts, test reports, временные screenshots и не относящиеся к фиче infra-правки не переносить.

Прототип считать исследованием, а не готовой реализацией. Целевой diff должен быть заметно меньше исходных 70 файлов и не переносить template behavior в `main.ts`, если оно относится к registry, API materialization, room-state или scene loading.

### 2. Канонический versioned registry

В `packages/shared-types` определить публичные типы template metadata, defaults, logical surfaces и runtime settings. В `packages/templates` хранить единственный встроенный registry:

| Template | Version | Default scene | Обязательный сценарий |
|---|---|---|---|
| `personal-room-basic` | `1.0.0` | `personal-workspace-v1@1.0.0` | owner-bound private workspace, private notes, focused workspace surface |
| `meeting-room-basic` | `1.0.0` | `meeting-room-v1@1.0.0` | 2-4 participants, round-table seats, spatial audio, display + collaboration wall |
| `presentation-room-basic` | `1.0.0` | `presentation-room-v1@1.0.0` | audience seats, join-muted default, PDF/screen-share presentation surface |

Versioned content включает `sceneReleaseId`, immutable relative `manifestPath`, `previewPath` и SHA-256 release manifest, `scene.json`, GLB и preview. `status` и `currentVersion` относятся к mutable catalog state и не входят в content hash immutable template version.

Asset lock каждой template version содержит собственные `repository` и `commitSha`. При отсутствии mirror config API строит official URL как `https://cdn.jsdelivr.net/gh/<repository>@<commitSha>/<relative-path>` и сохраняет в room snapshot resolved scene URL, release ID и expected checksums. `ROOM_TEMPLATE_ASSET_BASE_URL` является optional self-host mirror root; под ним byte-identical files размещаются в namespaced layout `<owner>/<repository>/<commitSha>/<relative-path>`, чтобы один mirror обслуживал несколько independent scene repositories без коллизий. Смена mirror root влияет только на catalog previews и комнаты, созданные после изменения; существующие absolute room URLs меняются только отдельной будущей rebind-операцией. Production config принимает только HTTPS; local tests могут использовать loopback HTTP fixture origin.

Confirmed implementation gap на 2026-08-12: текущий platform `main` всё ещё использует один `STANDARD_ROOM_ASSETS_REPOSITORY`, один `STANDARD_ROOM_ASSETS_COMMIT_SHA`, root `scene-assets.lock`, checkout `.scene-assets` и `resolveRoomTemplateAssetUrl(baseUrl, relativePath)` без asset lock. До импорта новых one-scene releases отдельный platform slice должен заменить это на per-definition repository/SHA resolution, machine-readable multi-repository lock и CI checkout/validation каждого exact release. Existing rooms и historical `scene-assets` definitions сохраняют свои абсолютные pinned URLs; Wave 2/3 contracts и activation state этим не меняются.

Правила версий:

- Любое изменение versioned defaults, logical surfaces, asset lock или runtime settings требует новой template version.
- Patch version используется для обратно совместимого исправления locked assets/defaults, minor — для новой optional capability/default, major — для несовместимого schema/behavior contract.
- `status` можно менять без новой version, потому что он управляет только доступностью create; содержимое historical version остаётся неизменным.
- Room manifest сохраняет `schemaVersion: 1`, пока добавляемые template fields optional для старого runtime; несовместимое изменение требует новой manifest schema.
- Content hash считается как SHA-256 от UTF-8 canonical JSON: object keys сортируются лексикографически, array order сохраняется, поля со значением `undefined` не сериализуются.

`personal-workspace-basic`, `showroom-basic`, `event-demo-basic` и `meeting-room-basic@0.1.0` остаются historical definitions. В Wave 1/2 четыре legacy catalog rows ещё active ради совместимого rollout. Только атомарная Wave 3 activation переводит первые три IDs в `deprecated` и переключает `meeting-room-basic.currentVersion` с `0.1.0` на `1.0.0`; historical versions остаются доступны для чтения pinned rooms, но не для create.

### 3. Copy-on-create и неизменяемый binding

API является authoritative resolver. При create он выбирает точную active version, накладывает пользовательские overrides на defaults, проверяет invariants и сохраняет:

- `template_id` и `template_version`;
- resolved immutable `scene_bundle_url`, `sceneReleaseId` и expected checksums;
- существующие room fields: type, visibility, guest policy, features, theme и avatar config;
- merged `template_snapshot` с notes policy, join-muted default, logical surfaces и asset lock, необходимыми manifest и room-state.

Целевой create contract после Wave 2: без `templateVersion` API выбирает active `currentVersion`; переданная клиентом известная version обязана совпасть с active current version, иначе возвращается `409 template_version_not_current`. Historical exact-version lookup остаётся внутренним/read-only contract для pinned rooms. Wave 1 ради совместимости ещё игнорирует клиентские `templateVersion`/`templateSnapshot` как недоверенные поля и всегда вычисляет их на сервере.

Начиная с Wave 2 direct create использует точные ошибки:

| Input | HTTP/error |
|---|---|
| malformed `templateVersion` | `400 invalid_template_version` |
| unknown `templateId` | `400 unknown_template` |
| syntactically valid, но unknown version | `400 unknown_template_version` |
| известная historical/non-current version | `409 template_version_not_current` |
| current parent имеет status `deprecated` | `409 deprecated_template` |
| клиент передал server-owned `templateSnapshot` | `400 server_owned_template_snapshot` |

Wave 1 продолжает игнорировать оба server-owned поля только до фиксации минимального rollback SHA; Wave 2 и последующие waves их больше не игнорируют.

Personal invariants нельзя ослабить override: нужен owner, room остаётся `personal`, `private`, всегда имеет `guestAllowed=false` и использует invite policy FEAT-019. Противоречивый input отклоняется стабильной field-level ошибкой, а не молча исправляется.

В целевом contract FEAT-032 `templateId` и `templateVersion` неизменяемы после создания. Обычный и admin PATCH, пытающиеся изменить binding, возвращают `409 template_change_not_supported`. Wave 1 сохраняет legacy switch behavior только как временный rollback-compatible bridge; запрет включается в Wave 2 одновременно для Memory/Postgres/API после mutating compatibility rehearsal. Template migration, rebind external assets, state conversion и session reconnect выносятся в отдельную feature task.

Точная модель ownership:

| Данные | Authoritative source после create |
|---|---|
| Access, room type, owner, voice, spatial audio, screen share, theme, avatar config | Persisted room fields |
| Notes policy, join-muted default, logical surface IDs/purpose/allowed object types, asset release lock | Неизменяемая version-owned часть persisted `template_snapshot` |
| Копия room type/access/features/theme/avatar config для manifest и диагностики | Обновляемая `template_snapshot.roomConfig`, пересобираемая только из persisted room fields |
| Spawn, bounds, seats, physical surface dimensions/transforms | Locked `scene.json` |
| Catalog status/current version/preview для новых комнат | Mutable `templates` catalog |
| Historical version content | Immutable `template_versions` row + content hash |

Runtime и room-state не разрешают registry повторно. API строит merged snapshot один раз; manifest и signed session context передают только необходимые части snapshot.

`packages/templates` является release source для seed. После успешного init immutable `template_versions` row и version-owned часть room `template_snapshot` являются runtime authority; startup сравнивает canonical content hash и останавливается при drift между package seed и сохранённой version. Обычный PATCH может пересобрать только `roomConfig` из persisted room fields и обязан дословно копировать locked contract из exact `template_versions` row.

### 4. Отдельный public repository для каждой сцены

Каждая новая original scene получает отдельный public repository с versioned layout вида:

```text
source/...
provenance/...
assets/scenes/<scene-id>/1.0.0/scene.json
assets/scenes/<scene-id>/1.0.0/scene.glb
assets/scenes/<scene-id>/1.0.0/preview.webp
assets/scenes/<scene-id>/1.0.0/LICENSES.md
manifest.json
```

Repository boundary разрешает ровно один `sceneId` и отклоняет второй scene root. Каждая release path immutable. CI каждого scene repository проверяет, что уже опубликованный `<scene-id>/<version>` не изменяется, checkout-ит platform по SHA из `platform-validator.lock`, собирает workspace validator, запускает Khronos glTF Validator, glTF Transform inspect и `@vrata/asset-pipeline`, считает SHA-256/size/stats и только затем создаёт Git release/tag. Official URL использует jsDelivr с полным release commit SHA, CORS и versioned cache; self-host может зеркалировать ту же byte-identical структуру и заменить только base URL. Git submodules/subtree и копирование scene binaries между repositories запрещены.

### 5. Три самостоятельные original scenes

Сцены создаются как оригинальные VRATA assets в едином визуальном языке, но с разной композицией и назначением:

| Scene | Минимальное содержание | Spatial contract |
|---|---|---|
| Personal workspace | desk/work surface, storage/reading zone, спокойный focused lighting | main spawn, owner workspace surface, без shared audience layout |
| Meeting room | central table, четыре различимых места, shared display, collaboration wall | 4 seat anchors к центру, `debug-main`, `whiteboard-wall` |
| Presentation room | stage/focal wall, большой экран, проходы и audience seating | минимум 6 audience seat anchors, `debug-main`, безопасный spawn вне rows |

Физические `mediaSurfaces`, spawn и seats описываются в `scene.json` и совпадают с видимой геометрией. Template registry задаёт logical purpose и allowlist object types. Release validator отклоняет template/scene pair, если required surface ID отсутствует, размеры невалидны или seat layout не соответствует заявленному сценарию.

Preview создаётся из финального runtime spawn view после прохождения lighting/material checks. Схематические SVG из прототипа удалить или оставить только как тестовые fixtures вне product catalog.

### 6. Control plane и runtime

Control plane показывает только active templates для create: preview, label, description, version и ключевые defaults. При выборе шаблона форма получает defaults; пользователь может менять theme и разрешённые общие settings. Reference scene является частью immutable template version: create/PATCH не принимают `sceneBundleUrl` override, а post-create rebind запрещён. Existing legacy/custom rooms сохраняют старый scene binding contract. Для personal template UI требует owner и не предлагает несовместимые access controls.

Runtime получает template ID/version/settings из manifest, но загружает сцену только по resolved `sceneBundle.url`. После загрузки runtime объединяет logical template surfaces с visual-only scene surfaces по стабильному `surfaceId`; отсутствие required ID является диагностируемой ошибкой, а не тихим перенаправлением на `debug-main`.

Room-state создаёт только разрешённые logical surfaces из подписанного API-issued template/session context. Scene transform не становится room-state authority. Template binding не меняется в течение жизни комнаты, поэтому FEAT-032 не добавляет новый reconnect/session migration path.

### 7. DB expand/activate и поэтапная поставка

DB rollout выполняется expand-first:

- Wave 1 создаёт immutable `template_versions`, добавляет nullable `rooms.template_version` и `rooms.template_snapshot`, seed-ит historical `0.1.0` definitions и backfill-ит compatibility snapshot из фактических persisted room fields без назначения новой scene. Его version-owned часть пока содержит только identity/label/asset slots, а `roomConfig` намеренно восстанавливается после legacy PATCH.
- Wave 1 backfill-ит существующие rows и добавляет composite FK `(template_id, template_version) -> template_versions` с nullable compatibility columns. Старый image может создать row без новых полей; следующий запуск Wave 1 восстанавливает null/stale metadata из фактических room fields.
- Wave 1 является обязательным compatibility release: он понимает catalog status/version columns, но ещё не содержит current rows новых template IDs. До Wave 2 допустим rollback на проверенный pre-Wave1 SHA.
- Wave 2 начинается только после закрепления Wave 1 SHA как минимальной rollback target, проверяет `count(*) filter (where template_version is null or template_snapshot is null)=0`, добавляет `NOT NULL`, platform contracts и immutable new-version rows. Для новых IDs сначала создаются catalog parent rows со status `deprecated` и nullable current pointer, затем version rows, затем parent `currentVersion=1.0.0`; `meeting-room-basic@1.0.0` добавляется рядом с current `0.1.0`. Ни одна candidate version не доступна для create.
- Wave 2 миграция пересобирает каждый room snapshot как exact immutable version snapshot + `roomConfig` из persisted room fields, проверяет identity/hash и только затем включает запрет PATCH binding. Последующие обычные PATCH обновляют только persisted room fields и `roomConfig`, не policy/surfaces/asset lock.
- Wave 2 проходит mutating compatibility rehearsal на Wave 2 schema: create/PATCH/manifest сначала Wave 2 image, затем Wave 1 image, затем снова Wave 2 image. Только после этого pre-Wave1 SHA удаляется из rollback targets.
- Wave 3 после публикации assets и exact asset lock одной guarded transaction активирует `personal-room-basic@1.0.0` и `presentation-room-basic@1.0.0`, переключает `meeting-room-basic.currentVersion` на `1.0.0`, оставляет его active и переводит `personal-workspace-basic`, `showroom-basic`, `event-demo-basic` в `deprecated`. Transaction проверяет точное ожидаемое Wave 2 состояние до изменения.
- Wave 3 rollback отдельной idempotent guarded transaction восстанавливает полное Wave 2 состояние: meeting pointer `0.1.0`/active, три legacy aliases active, два candidate parent rows deprecated@`1.0.0`. После проверки list/create возвращается Wave 2 image. Возврат напрямую на Wave 1 или pre-Wave1 запрещён.

Состояния mutable catalog:

| Wave | Active для create/list | Deprecated/inactive parents | `meeting-room-basic.currentVersion` | Допустимый rollback image |
|---|---|---|---|---|
| 1 | meeting, showroom, event-demo, personal-workspace `0.1.0` | нет | `0.1.0` | pre-Wave1 до появления version > `0.1.0` |
| 2 | те же четыре legacy rows | personal-room `1.0.0`, presentation-room `1.0.0`; meeting `1.0.0` только historical row | `0.1.0` | Wave 1 |
| 3 | personal-room, meeting, presentation `1.0.0` | personal-workspace, showroom, event-demo и historical versions | `1.0.0` | Wave 2 после catalog rollback transaction |

После успешного Wave 2 staging gate workflow один раз сохраняет exact SHA в отдельный immutable `wave2-rollback-sha` marker. Это не общий current-successful marker: Wave 3 deploy/gate не перезаписывает его. Activation command и rollback workflow обязаны проверить marker, expected catalog state и deployed image SHA до любой мутации.

| Этап | Результат | Условие перехода |
|---|---|---|
| A. Prototype recovery | Чистый scoped diff и зафиксированные architecture decisions | package tests зелёные, unrelated diff удалён |
| B. Platform contract | Shared schema, validator и exact DB Wave 1 без новых product IDs | migration/backfill/rollback verification зелёные |
| C. Scene repository PoC | Single-scene public repo, locked platform validator и byte-identical mirror contract | test bundle доступен по full-SHA URL и с mirror |
| D. Three scene releases | Три original `1.0.0` bundles и реальные previews | static/runtime validators проходят для каждой сцены |
| E. Platform integration | Wave 2, API/control-plane/runtime integration и exact asset lock без current catalog activation | unit/integration/full local e2e зелёные |
| F. Activation and acceptance | Wave 3 атомарно формирует exact active set из трёх reference templates | CI/CD, staging и physical-device QA зелёные |

Wave 3 сначала активируется только на internal staging. Последовательность: asset preflight → deploy exact Wave 3 image с неактивными candidates → guarded activation command → assertion точного Wave 3 catalog state → automated staging gate → physical-device QA. Production/release promotion выполняется после automated и physical-device acceptance. Если staging gate или device QA не проходит, выполняется guarded rollback transaction к точному Wave 2 catalog state, новые test rooms удаляются и только затем разворачивается SHA из `wave2-rollback-sha`.

Cross-repo handoff выполняется без плавающих ссылок:

1. Platform Stage B публикует contract/validator commit SHA.
2. Каждый scene repository записывает этот SHA в `platform-validator.lock`, валидирует свою единственную scene и публикует release commit SHA + `manifest.json` с checksums.
3. Platform Stage E импортирует три exact scene release SHA, repository IDs, paths и checksums в template version definitions.
4. Platform CI checkout-ит каждый scene release SHA, сравнивает imported locks с release manifests и отклоняет drift до merge.
5. Platform Stage E checkout-ит каждый scene release и повторно запускает уже финальный validator/template-pair contract, а не только сравнивает lock-файлы.
6. Staging preflight скачивает official/mirror bytes и сверяет checksums до Wave 3 activation.
7. Runtime сверяет SHA-256 `scene.json` и GLB до parse/render. Product GLB обязан содержать textures/resources внутри, поэтому verified GLB покрывает транзитивные runtime assets; mismatch завершает load стабильной ошибкой и не помечается `loaded`.

## Задачи

### Подготовка и аудит прототипа

- [ ] Создать новую branch/worktree от последнего `origin/main` и записать точный base SHA.
- [ ] Экспортировать существующий незакоммиченный FEAT-032 diff в patch без изменения исходного worktree.
- [ ] Составить mapping всех 70 затронутых файлов: `reuse`, `rewrite`, `drop`, с кратким обоснованием для каждого широкого session/infra изменения.
- [ ] Перенести сначала shared types, registry и их tests; подтвердить, что package build/test проходит до backend integration.
- [ ] Исключить generated `dist`, Playwright reports, screenshots и unrelated formatting из implementation diff.
- [ ] Разбить поставку минимум на platform core, assets pipeline/scenes и final integration PR; не отправлять исходный монолитный diff на ревью.

### Template contract и registry

- [ ] Добавить `RoomTemplateMetadata`, `RoomTemplateDefaults`, `RoomTemplateSurface` и runtime settings в `@vrata/shared-types` без зависимости от Three.js.
- [ ] Зафиксировать stable schema/version semantics и проверить unique `(id, version)` для всех definitions.
- [ ] Добавить три immutable reference version definitions `1.0.0` с relative scene/preview paths и описанными defaults; active/deprecated хранится только в mutable catalog, не в version definition.
- [ ] Добавить historical version definitions для legacy IDs и `meeting-room-basic@0.1.0`; replacement links являются metadata, а status parent rows меняется только Wave 3 transaction.
- [ ] Реализовать pure registry lookup/list/materialization functions в `@vrata/templates`; storage не должен владеть merge rules.
- [ ] Сделать returned metadata defensive copies/immutable snapshots и покрыть попытку mutation unit test.
- [ ] Добавить проверку required surface IDs и object types против зарегистрированных media extensions.
- [ ] Зафиксировать stable errors по таблице HTTP contract: malformed version, unknown template/version, known non-current version, deprecated parent, server-owned snapshot, invalid asset base URL и template invariant violation.

### Single-scene repositories и публикация

- [ ] [1-2ч] Подтвердить Definition of Ready: имена трёх scene repos, permissions, official full-SHA URL shape, QA owner и devices; сохранить решение в repository READMEs.
- [ ] [1ч на scene] Создать отдельный public scene repository с security policy, branch protection и CODEOWNERS; общий `scene-assets` не использовать для новых releases.
- [ ] [1-2ч на scene] Добавить source/generated/release directory contract, automated one-scene boundary и закрепить DCC/Blender version.
- [ ] [1-2ч] Добавить deterministic export command для одной fixture scene и проверить повторяемость stats/checksums.
- [ ] [1-2ч на scene] Добавить `platform-validator.lock` и checkout platform по полному SHA в CI.
- [ ] [2-3ч на scene] Добавить root `manifest.json` schema и validator tests для единственного scene ID, paths, versions, SHA-256, sizes, stats и release status.
- [ ] [2-3ч на scene] Подключить Khronos glTF Validator, glTF Transform inspect и собранный platform scene validator.
- [ ] [1-2ч на scene] Добавить CI-защиту immutable paths: изменение уже опубликованной scene version должно завершаться ошибкой.
- [ ] [1-2ч на scene] Добавить release workflow, который создаёт tag только после validation и выводит jsDelivr URL с полным repository commit SHA.
- [ ] [1-2ч] Описать mirror procedure и checksum verification без переписывания manifest.
- [ ] [1-2ч] Проверить official origin и локальное зеркало одинаковым smoke: `scene.json`, `scene.glb`, `preview.webp`, content types, CORS и checksums.

### Personal workspace scene

- [ ] [2-3ч] Создать original blockout с desktop/mobile/VR scale и пройти композиционное review против private/legacy references.
- [ ] [2-3ч] Выполнить geometry pass помещения и крупных props; снять первый triangles/objects budget report.
- [ ] [2-3ч] Выполнить workspace furniture/detail pass без выхода за 70% hard geometry budget.
- [ ] [2-3ч] Создать/reuse original PBR material kit и проверить color spaces/texture limits.
- [ ] [2-3ч] Настроить lighting и первый runtime spawn view без broad material overrides.
- [ ] [1-2ч] Разместить main spawn и visual workspace surface; проверить head clearance и navigation.
- [ ] [1-2ч] Подготовить `scene.json`, provenance/rights metadata и `LICENSES.md`.
- [ ] [2-3ч] Выполнить dedup/prune/compression pass и устранить static validator failures.
- [ ] [1-2ч] Снять финальный runtime preview и проверить visual thresholds.
- [ ] [1-2ч] Проверить private notes/workspace flow на final candidate.
- [ ] [1ч] Опубликовать immutable `personal-workspace-v1@1.0.0` и записать release checksums.

### Meeting room scene

- [ ] [2-3ч] Создать original small-meeting blockout и пройти композиционное review.
- [ ] [2-3ч] Выполнить room/table/large-props geometry pass и снять первый budget report.
- [ ] [2-3ч] Выполнить furniture/detail pass без выхода за 70% hard geometry budget.
- [ ] [2-3ч] Применить original PBR material kit и проверить texture/material budgets.
- [ ] [2-3ч] Настроить lighting и читаемый runtime spawn view.
- [ ] [1-2ч] Добавить четыре visual seats и non-overlapping anchors, направленных к центру.
- [ ] [1-2ч] Добавить visual-only surfaces `debug-main` и `whiteboard-wall`; `debug-main` явно закрепить как legacy-compatible public ID для v1.
- [ ] [1-2ч] Подготовить manifest, rights metadata и `LICENSES.md`.
- [ ] [2-3ч] Выполнить optimization/validation pass и получить combined mobile-lite/XR green report.
- [ ] [1-2ч] Снять финальный runtime preview и проверить visual thresholds.
- [ ] [2-3ч] Проверить 2-4 participant presence, seating, voice/spatial audio, screen share и whiteboard.
- [ ] [1ч] Опубликовать immutable `meeting-room-v1@1.0.0` и записать release checksums.

### Presentation room scene

- [ ] [2-3ч] Создать original stage/audience blockout с безопасными проходами и пройти review.
- [ ] [2-3ч] Выполнить room/stage/large-screen geometry pass и снять первый budget report.
- [ ] [2-3ч] Выполнить audience furniture/detail pass без выхода за 70% hard geometry budget.
- [ ] [2-3ч] Применить original PBR material kit и проверить texture/material budgets.
- [ ] [2-3ч] Настроить lighting и экран как первый визуальный фокус spawn view.
- [ ] [1-2ч] Добавить минимум шесть visual seats и audience anchors, направленных на экран.
- [ ] [1-2ч] Добавить visual-only `debug-main` с проверенным PDF/video aspect ratio; сохранить ID как v1 compatibility contract.
- [ ] [1-2ч] Подготовить manifest, rights metadata и `LICENSES.md`.
- [ ] [2-3ч] Выполнить optimization/validation pass и получить combined mobile-lite/XR green report.
- [ ] [1-2ч] Снять финальный runtime preview и проверить visual thresholds.
- [ ] [2-3ч] Проверить PDF first page/page sync/late join/presenter controls/screen share/stop cleanup.
- [ ] [1ч] Опубликовать immutable `presentation-room-v1@1.0.0` и записать release checksums.

### API, persistence и config

- [ ] [1-2ч] Добавить `template_versions` schema с composite PK, immutable content hash и mutable-status exclusion test.
- [ ] [1-2ч] Добавить nullable `rooms.template_version` и `rooms.template_snapshot` в expand migration.
- [ ] [2-3ч] Seed historical `0.1.0` definitions и backfill snapshot из persisted room fields без новой scene/defaults.
- [ ] [1ч] Добавить SQL assertion/diagnostic количества незаполненных rows; в Wave 1 не вводить `NOT NULL`, пока допустим rollback на pre-migration image.
- [ ] [1-2ч] Добавить nullable-compatible composite FK `(template_id, template_version)` и проверить existing fixture DB upgrade.
- [ ] [1-2ч] Обновить `templates` до mutable catalog `status/current_version`, не вставляя новые current IDs в Wave 1.
- [ ] [1-2ч] Сделать seed idempotent; конфликт immutable content уже записанной version останавливает startup.
- [ ] [2-3ч] Проверить old-shape INSERT/PATCH на Wave 1 DB, повторный healing init и зафиксировать Wave 1 SHA как минимальную rollback target перед Wave 2 `NOT NULL`.
- [ ] [1-2ч] Wave 2: проверить отсутствие null metadata и добавить `NOT NULL` только после mutating Wave 1 rollback rehearsal.
- [ ] [1-2ч] Wave 2: создать deprecated catalog parents для новых IDs, seed-ить immutable `1.0.0` rows без active catalog activation и проверить content conflicts.
- [ ] [1-2ч] Wave 2: преобразовать Wave 1 compatibility snapshots в exact version-owned contract + mutable `roomConfig`, затем включить binding immutability.
- [ ] [2-3ч] Выполнить rehearsal Wave 2 image → Wave 1 image → Wave 2 image с create/PATCH/manifest на одной DB.
- [ ] [1ч] После успешного Wave 2 staging gate записать отдельный immutable `wave2-rollback-sha`; Wave 3 workflow не должен перезаписывать marker общим successful SHA.
- [ ] [1-2ч] Добавить guarded idempotent activation/deactivation transactions для таблицы Wave 2/3 состояний, включая meeting pointer и legacy statuses; seed не должен реактивировать `deprecated` row.
- [ ] [2-3ч] Обновить staging rollback: до image rollback выполнить deactivation даже при неработающем API через локальный operator script/SQL, проверить target SHA = Wave 2 и только затем переключать image.
- [ ] [1-2ч] Добавить automated failed-gate test, который подтверждает exact Wave 2 catalog restore, deploy SHA из marker и отсутствие active `1.0.0` references в create/list после рестарта.
- [ ] [1ч] Добавить `ROOM_TEMPLATE_ASSET_BASE_URL` в env examples, compose profiles и production config validation.
- [ ] [1-2ч] Нормализовать optional mirror root и безопасно разрешать только `<owner>/<repository>/<commitSha>/<relative-path>` из immutable asset lock без traversal/user input.
- [ ] [1-2ч] Заменить single `scene-assets.lock`/checkout на machine-readable lock трёх repositories и CI validation каждого exact commit/release.
- [ ] [1-2ч] Обновить resolver: official jsDelivr URL строится из `assetLock.repository` + `assetLock.commitSha`, self-host mirror использует namespaced repository/SHA layout.
- [ ] [1ч] Разрешать official HTTPS origin и self-host mirror override; не смешивать настройку с `SCENE_BUNDLE_S3_PUBLIC_BASE_URL` uploads.
- [ ] [2-3ч] Реализовать pure defaults/override merge и unit tests до подключения HTTP create.
- [ ] [2-3ч] Подключить merge к API create, затем выполнить room validation и invariants tests.
- [ ] [1-2ч] Записывать resolved scene URL и полный asset lock в room snapshot.
- [ ] [1-2ч] Отклонять create/PATCH `sceneBundleUrl` override для active reference templates.
- [ ] [1-2ч] Отклонять deprecated/unknown/non-current template version, сохраняя authenticated exact-version read existing legacy rooms.
- [ ] [1ч] Запретить изменение `templateId`/`templateVersion` после create стабильной ошибкой `409 template_change_not_supported`.
- [ ] [1-2ч] Добавить `templateVersion` и минимальную config в room API/manifest без второго registry lookup.
- [ ] [1-2ч] Добавить bounded metrics выбора, successful create и ошибок.

### Control plane

- [ ] [1-2ч] Обновить typed client `TemplateRecord` и room DTO для version/status/preview/defaults.
- [ ] [1-2ч] Фильтровать deprecated templates из create selector и показывать pinned legacy metadata существующей комнаты.
- [ ] [2-3ч] Реализовать preview card с label, description, version и defaults summary.
- [ ] [1-2ч] Применять defaults к draft один раз и подтверждать reset явных user edits.
- [ ] [1-2ч] Для personal template требовать owner и блокировать несовместимые access controls.
- [ ] [1-2ч] Показывать stable inline errors и saved template/scene details после create.
- [ ] [2-3ч] Проверить keyboard/mobile/alt-text доступность preview cards и form.

### Runtime и room-state

- [ ] [1-2ч] Прочитать template ID/version/settings из manifest и добавить их в boot/debug snapshots.
- [ ] [1ч] Загружать default scene только через существующий `sceneBundle.url` без provider-specific path.
- [ ] [2-3ч] Реализовать pure matcher logical/visual surfaces по ID и negative unit tests.
- [ ] [1-2ч] Подключить matcher к runtime и диагностировать missing/duplicate required IDs.
- [ ] [1ч] Проверить, что physical transforms поступают только из scene manifest.
- [ ] [2-3ч] Проверить SHA-256 raw `scene.json` через WebCrypto до parse и вернуть stable checksum mismatch code.
- [ ] [2-3ч] Загружать GLB bytes через verified fetch, сверять SHA-256 и передавать проверенный buffer в существующий loader parse path.
- [ ] [1-2ч] Покрыть manifest/GLB mismatch, network failure и successful verified load unit/integration tests.
- [ ] [2-3ч] Добавить минимальный signed template context для room-state logical surfaces.
- [ ] [2-3ч] Проверить room-state allowlisted object types и negative authorization cases.
- [ ] Сохранить правило, что scene loading/room callbacks не записывают local player pose напрямую вне `apps/runtime-web/src/local/` и frame locomotion pipeline.
- [ ] Проверить, что room-state использует pinned snapshot на всём протяжении жизни комнаты и не добавляет template migration/reconnect behavior.
- [ ] При недоступном external asset origin показать stable diagnostic/error UI и перейти в существующий safe fallback, не выдавая fallback за успешно загруженную template scene.
- [ ] Убедиться, что post-create scene rebind reference room отклоняется, а existing legacy/custom room scene override продолжает работать по старому contract.

### Документация и завершение

- [ ] Добавить `docs/room-templates.md` с назначением трёх templates, versioning, override rules, legacy policy и self-host mirror setup.
- [ ] Обновить API/manifest, control-plane, runtime, observability, Postgres и security docs только в затронутых контрактах.
- [ ] Обновить `docs/scene-bundle-contract.md`, если external reference scene paths или template/scene surface validation добавляют новый нормативный contract.
- [ ] Обновить `docs/asset-license-audit.md` ссылками на public assets releases и provenance каждого original scene.
- [ ] Обновить `CHANGELOG.md` как публичную возможность после фактической staging/device приёмки.
- [ ] Исправить stale status/checkbox FEAT-024/025 только после сверки их merged acceptance evidence; не смешивать это с заявлением готовности FEAT-032.
- [ ] После прохождения всех критериев отметить FEAT-032 completed в исходной карточке, `docs/plans/CHECKLIST.md` и release notes.

## Затронутые файлы и модули

### Platform repository: новые или вероятно новые файлы

- `packages/shared-types/src/room-template.ts` — shared template metadata contract.
- `apps/runtime-web/src/template-layout.ts` — pure merge logical template surfaces и scene visual surfaces, если существующий scene/session module нельзя расширить без смешения ответственности.
- `apps/runtime-web/src/template-layout.test.ts` — layout/compatibility unit tests.
- `docs/room-templates.md` — user/operator/developer contract.
- `tools/validate-reference-template-assets.mjs` — cross-repo lock/manifest compatibility трёх independent scene repositories.

### Platform repository: изменяемые зоны

- `packages/templates/src/index.ts`, `packages/templates/src/registry.ts`, `packages/templates/src/index.test.ts`, `packages/templates/package.json`.
- `packages/shared-types/src/index.ts`, `packages/shared-types/src/index.test.ts`, `packages/shared-types/src/media-objects.ts`, session token types/tests при необходимости signed template context.
- `apps/api/src/storage.ts`, `apps/api/src/storage.test.ts` — schema/backfill/catalog/version snapshots.
- `apps/api/src/index.ts`, `apps/api/src/index.test.ts` — list/create/update/manifest/config/metrics contracts.
- `apps/api/package.json`, `apps/api/Dockerfile`, `pnpm-lock.yaml` — dependency/build packaging `@vrata/templates`.
- `apps/control-plane/index.html`, `apps/control-plane/src/index.ts`, `apps/control-plane/src/main.ts`, `apps/control-plane/src/styles.css` и tests.
- `apps/runtime-web/src/index.ts`, `apps/runtime-web/src/boot-session.ts` или текущие startup modules, `apps/runtime-web/src/main.ts` только для composition wiring, scene/session modules и tests.
- `apps/room-state/src/state.ts`, `apps/room-state/src/index.ts` и tests — logical surface initialization/template claim checks.
- `.env.example`, `infra/docker/.env.*.example`, `infra/docker/compose.*.yml`, production config validator/tests.
- `tests/e2e/runtime.spec.ts`, `tests/e2e/runtime-staging.spec.ts` и при необходимости focused M1 media specs.
- `.github/workflows/ci.yml` и `.github/workflows/staging-deploy.yml` только для реального нового config/contract gate; unrelated rollout refactor из прототипа не переносить.
- `README.md`, `docs/api-contracts.md`, `docs/control-plane.md`, `docs/runtime.md`, `docs/observability.md`, `docs/postgres-baseline.md`, `docs/security.md`, `docs/product-scope.md`, `CHANGELOG.md`.

### Public single-scene repositories

- Personal, meeting и presentation scene имеют по отдельному repository и не делят source/release history.
- В каждом repository: `source/**`, `provenance/**`, `assets/scenes/<scene-id>/1.0.0/scene.json`, `scene.glb`, `preview.webp`, `LICENSES.md`.
- В каждом repository: собственные `manifest.json`, `platform-validator.lock`, schema/validator tests, `.github/workflows/validate.yml` и publication workflow.
- В каждом repository: authoring/export/optimization scripts и reproducibility docs только своей сцены.

## Тест-план

### Unit: template и URL contracts

- [ ] Immutable registry содержит ровно три reference `1.0.0` version definitions с unique IDs/versions и expected defaults без mutable status.
- [ ] Historical IDs/versions разрешаются для existing room; после Wave 3 create возвращает `deprecated_template`, а explicit historical version текущего ID — `template_version_not_current`.
- [ ] Mutation результата lookup не меняет канонический registry или historical snapshot.
- [ ] Defaults merge сохраняет explicit allowed overrides и не ослабляет personal invariants.
- [ ] Любая попытка template switch после create возвращает `409 template_change_not_supported`, а обычный room PATCH не переустанавливает defaults.
- [ ] Unknown ID/version, malformed version, duplicate surface и unavailable media object type дают stable errors.
- [ ] Base URL resolver одинаково обрабатывает trailing slash и mirror origin, отклоняет traversal, credentials, query injection и non-HTTPS production URL.
- [ ] Required template surfaces совпадают с expected scene manifest surface IDs.

### Unit/integration: storage, API и room-state

- [ ] Memory и Postgres paths одинаково seed current/history metadata и backfill existing room version `0.1.0`.
- [ ] Wave 2 catalog fixture показывает четыре active legacy parents и два deprecated candidate parents; active `1.0.0` references в create/list отсутствуют.
- [ ] Isolated Wave 3 fixture guarded transaction активирует ровно три references, выполняет product checks и в `finally` восстанавливает exact Wave 2 state.
- [ ] Повторный startup idempotent; изменение содержимого существующей immutable version завершается `template_version_immutable_conflict`.
- [ ] `GET /api/templates` возвращает только active current versions и resolved preview URLs; pinned legacy metadata приходит только в room record/manifest или authenticated exact-version lookup.
- [ ] Create каждого active template сохраняет точную version, resolved scene URL и expanded defaults.
- [ ] Прямой API create и control-plane create дают эквивалентные persisted fields.
- [ ] Personal create без owner, с public visibility или несовместимым template отклоняется ожидаемым code.
- [ ] Existing legacy room продолжает manifest/token/join flow после schema migration.
- [ ] Active reference template create/PATCH отклоняет любой scene override; template snapshot, URL, release ID и checksums остаются согласованными.
- [ ] Existing custom/legacy room сохраняет прежний explicit scene contract.
- [ ] Обычный room PATCH не меняет version-owned policy/surfaces/asset lock и пересобирает только `roomConfig` из persisted fields; отдельный migration test проверяет переход с Wave 1 compatibility snapshot.
- [ ] Concurrent попытки template update обе получают deterministic `template_change_not_supported` и не меняют state.
- [ ] Missing template snapshot не приводит к silent fallback; manifest/API возвращает диагностируемую ошибку.

### Static asset validation

- [ ] Все три `scene.json` проходят schema/path/rights/spawn/bounds/anchors/media surfaces validation.
- [ ] Khronos glTF Validator возвращает zero errors; unsupported required extensions отсутствуют.
- [ ] glTF Transform inspect фиксирует triangles/objects/meshes/materials/textures и отсутствие extreme/helper bounds.
- [ ] Каждый bundle/GLB не превышает 15 MB, 90k triangles, 500 objects, 250 meshes, 96 materials и 48 textures.
- [ ] Все texture paths/resources разрешаются, max texture size соответствует policy, base-color color space и data textures корректны.
- [ ] Manifest rights block и `LICENSES.md` подтверждают original/internal ownership и разрешения staging/production/web/screenshots/optimization.
- [ ] Preview существует, соответствует финальному checksum/release и получен из реального runtime spawn view.
- [ ] Попытка изменить опубликованный `1.0.0` path блокируется CI соответствующего scene repository.

### Package/build checks

- [ ] `pnpm --filter @vrata/shared-types build && pnpm --filter @vrata/shared-types test`.
- [ ] `pnpm --filter @vrata/templates build && pnpm --filter @vrata/templates test`.
- [ ] `pnpm --filter @vrata/api build && pnpm --filter @vrata/api test`.
- [ ] `pnpm --filter @vrata/control-plane build && pnpm --filter @vrata/control-plane test`.
- [ ] `pnpm --filter @vrata/room-state build && pnpm --filter @vrata/room-state test`.
- [ ] `pnpm --filter @vrata/runtime-web build && pnpm --filter @vrata/runtime-web test`.
- [ ] Root lint/typecheck/build/test и production config validation проходят после env/compose changes.
- [ ] API Docker image содержит built `@vrata/templates`, но не содержит scene binaries из public scene repositories.

### Local e2e

Product e2e для трёх reference templates запускается на изолированной test DB: suite выполняет guarded Wave 3 activation fixture, проверяет exact active set и обязательно восстанавливает Wave 2 state в teardown. Обычный Wave 2 server без fixture не обязан и не должен разрешать create этих candidates.

- [ ] Focused control-plane test показывает три active preview cards, version metadata и корректно применяет defaults.
- [ ] Create через UI и direct API проходит для каждого template; deprecated/unknown selection отклоняется.
- [ ] Personal room открывает private notes/workspace и не допускает чужого участника без invite.
- [ ] Meeting room создаёт нужные logical surfaces и подтверждает 2-4 participant presence/audio behavior на local fixture scene.
- [ ] Presentation room показывает PDF, синхронизирует page с observer/late joiner и поддерживает screen share на `debug-main`.
- [ ] UI/API не позволяют сменить template binding существующей комнаты и не вызывают reconnect/session reset.
- [ ] External asset origin failure показывает controlled fallback/error; preview failure не блокирует выбор template и имеет alt/error state.
- [ ] Existing explicit scene bundle room, legacy template room и fallback room проходят regression scenarios.
- [ ] После focused checks один раз выполнить полный `pnpm test:e2e` на финальном platform tree.

### Local runtime visual checks

- [ ] Для каждой реальной сцены создать local room с published/mirrored URL и открыть `?debug=1&scenefit=0`.
- [ ] Дождаться `sceneDebug.state=loaded`, проверить `failureReason=null`, `missingAssets.length=0`, scene ID, bounds, meshes/materials и expected surface/seat counts.
- [ ] Проверить screenshot thresholds из `docs/scene-technical-requirements.md` и вручную подтвердить читаемый первый кадр.
- [ ] Проверить collision-free spawn, floor height, teleport и каждый seat anchor на desktop и synthetic XR.
- [ ] Проверить, что surfaces не z-fight с scene geometry и PDF/video/screen share имеют правильный aspect/visibility.

### Staging

- [ ] Сначала опубликовать три immutable scene releases и проверить official URLs/checksums/CORS независимо от platform deploy.
- [ ] Checkout-ить три scene releases в final platform CI и повторно выполнить final validator + template/scene pair validation на каждом pinned SHA.
- [ ] Установить staging `ROOM_TEMPLATE_ASSET_BASE_URL` на конкретный immutable release root и проверить config в rendered compose без secrets.
- [ ] Проверить, что immutable `wave2-rollback-sha` существует, указывает на прошедший Wave 2 gate и отличается от будущего Wave 3 SHA.
- [ ] Commit/push platform changes, дождаться CI/Docker Publish и развернуть exact Wave 3 SHA с candidates ещё в Wave 2 catalog state.
- [ ] Выполнить asset preflight official/mirror bytes и checksums, затем вызвать guarded activation command.
- [ ] SQL/API assertion подтверждает exact Wave 3 catalog state и deployed image SHA до создания test rooms; общий successful marker может обновиться, `wave2-rollback-sha` — нет.
- [ ] Создать отдельную staging room из каждого template и проверить manifest ID/version/default scene URL.
- [ ] Для каждой комнаты дождаться actual `sceneDebug.state=loaded`, `missingAssets.length=0`, expected surfaces/seats и сохранить runtime screenshot/debug evidence.
- [ ] Выполнить staging personal notes, 2-4 participant meeting/audio и two-client PDF/screen-share presentation scenarios.
- [ ] Запустить `pnpm test:e2e:staging` только после deployment проверяемого commit и успешной guarded activation.
- [ ] Повторно проверить baseline Hall, BlueOffice, ArtGallery и весь обязательный scene catalog, чтобы новый template path не сломал private scene overrides.
- [ ] Проверить self-host mirror на отдельном base URL: новая room использует mirror, existing pinned room не меняет URL автоматически.

### Physical-device acceptance

До начала scene release зафиксировать таблицу с QA owner, точным model, minimum OS/browser version и датой доступности каждого устройства. Для каждой пары device/scene выполнить три cold-load run на согласованной Wi-Fi/network profile, затем не менее 10 минут navigation/surface stability. Cold load измеряется от `performance.timeOrigin` новой navigation без warm HTTP cache до первого diagnostic с `sceneDebug.state=loaded`; каждый из трёх runs обязан уложиться в 20 секунд. Обязательные результаты: `loaded`, `missingAssets.length=0`, отсутствие crash/reload/OOM, корректный spawn и основной interaction flow. Capability, отсутствующая в браузере, принимается только при заранее указанном expected diagnostic/degraded UI. Meeting 2-4 participants создаются automated companion clients; spatial-audio audibility отдельно подтверждается минимум двумя реальными endpoints.

- [ ] Desktop Chromium: загрузить все три scenes, пройти movement/seating/surfaces и записать OS/browser/GPU/revision.
- [ ] Android Chrome: загрузить все три scenes, проверить touch navigation, memory stability, preview/control-plane layout и ключевой surface flow.
- [ ] iOS Safari: загрузить все три scenes, проверить WebGL load, touch navigation, memory reload behavior и ключевой surface flow.
- [ ] Meta Quest Browser: загрузить все три scenes, проверить spawn, frame usability, teleport, seats, controller ray и presentation visibility.
- [ ] Для каждого device/scene записать три cold-load durations, 10-minute stability result, memory/crash symptoms и expected degraded capabilities.
- [ ] На Quest записать refresh rate, median/p95 frame time, dropped/reprojected frames и stalls >100 ms; median не превышает device frame budget, p95 не превышает 2x budget, stalls составляют менее 0.1%, dropped/reprojected frames менее 5%.
- [ ] Для каждого device сохранить exact model, OS/browser versions, date, platform SHA, asset release/checksums, результаты и known issues.
- [ ] Обновить compatibility evidence только для фактически пройденных capabilities; failed/degraded результат не скрывать и не заменять mock evidence.

### Негативные и крайние случаи

- [ ] Asset origin недоступен, возвращает 404, неверный content type, CORS denial или checksum mismatch.
- [ ] Mirror изменяет `scene.json` или GLB после preflight; runtime checksum gate отклоняет bytes до parse/render.
- [ ] `scene.json` загружен, но GLB/preview отсутствует или surface ID не совпадает с template contract.
- [ ] Тяжёлая сцена достигает timeout или memory pressure на mobile/Quest; задача остаётся незавершённой до оптимизации, а не ослабления hard budget.
- [ ] Два template ID ссылаются на один mutable asset path; validator обязан отклонить такую publication mapping.
- [ ] Existing room pinned на historical version родительского template, который теперь deprecated или переключён на новый current, продолжает открываться.
- [ ] Existing room с explicit customer scene не переключается на reference scene при обычном update.
- [ ] Admin пытается изменить template personal/standard room; API возвращает `409 template_change_not_supported`, state и owner/private data не меняются.
- [ ] Пользователь меняет template после ручной правки form fields; UI запрашивает подтверждение перед reset и не выполняет silent data loss.
- [ ] Preview имеет broken URL или медленную загрузку; selector остаётся доступным и показывает fallback text.
- [ ] Template metrics не принимают произвольный user-provided ID как unbounded label.

## Риски и откаты

| Риск | Митигация |
|---|---|
| Прототип слишком велик и скрывает unrelated behavior changes | Recover as patch, file-by-file disposition, small PRs, baseline/focused tests до переноса следующего слоя |
| Public demo art раздует срок | Независимый acceptance каждой сцены, общий визуальный kit, ранний blockout/performance gate до детализации |
| Три external scenes нарушат self-host/offline сценарий | Configurable base URL, documented mirror layout, no provider-specific absolute paths в registry |
| Scene repository или CDN изменит файл под той же версией | Immutable version directories, CI diff guard, release checksums, long cache only для versioned paths |
| Mirror меняет bytes после preflight | Runtime SHA-256 verification manifest/GLB; mismatch не достигает parser и не получает state `loaded` |
| Cross-repo platform/template contract разойдётся | Machine-readable manifest каждой сцены, pinned platform validator в каждом scene CI, final integration test на exact releases |
| Existing rooms неожиданно получат новые defaults | Persist `templateVersion` и expanded room snapshot, никаких `follow latest`; binding immutable в FEAT-032 |
| Legacy template удалится из seed и сломает FK/manifest | Historical registry + persisted `template_versions`, backfill `0.1.0`, dedicated legacy regression test |
| Новый scope снова разрастётся в template migration | PATCH binding запрещён стабильной ошибкой; migration/provenance/reconnect вынесены в отдельную feature task |
| Scene seats/surfaces не совпадут с визуальной геометрией | Scene-owned transforms/anchors, template-owned logical allowlist, static pair validator + runtime/manual checks |
| Красивый desktop art не работает на mobile/Quest | Combined stricter budgets до art polish, physical Android/iOS/Quest acceptance до completion |
| Remote asset outage выглядит как успешный template | Отдельные scene load states, stable diagnostics, controlled fallback с явным warning |
| Default public origin создаёт обязательную внешнюю зависимость | Official origin только default; mirror override документирован и проверен, room хранит immutable resolved URL |
| Сцены случайно повторят private SenseTower content | Original blockout review, provenance records, no private source checkout в public authoring pipeline |

Rollback разделён по слоям:

- Platform rollback до Wave 2: вернуть проверенный pre-Wave1 или Wave1 SHA; после Wave 2 `NOT NULL` минимальной rollback target становится Wave 1 SHA, прошедший mutating rehearsal на Wave 2 schema.
- Platform rollback после activation: guarded transaction полностью восстанавливает Wave 2 catalog state, включая meeting pointer и legacy statuses, и только затем возвращается Wave 2 image. Wave 1 и pre-migration images не являются допустимыми targets.
- Template catalog rollback: guarded transaction восстанавливает exact Wave 2 state; meeting остаётся active на `0.1.0`, два новых parents становятся deprecated, три legacy aliases снова active. Исправление выпускается новой version, опубликованную `1.0.0` не переписывать.
- Asset rollback: переключить новую template definition на новый/предыдущий immutable release соответствующего scene repository в следующей template version; опубликованные paths не удалять и не заменять.
- Existing affected rooms сохраняют pinned snapshot и scene URL; автоматический rebind отсутствует. Исправление требует новой template version и отдельной будущей migration operation.
- Staging rollback: восстановить exact Wave 2 catalog state, развернуть SHA только из immutable `wave2-rollback-sha` и удалить лишь staging test rooms; изменение `ROOM_TEMPLATE_ASSET_BASE_URL` не переписывает existing room snapshots.
- До activation выполнить compatibility test Wave 1/2 rollback image на DB snapshot с одной неактивной immutable version и legacy rooms; image, не прошедшее этот test, не записывать как rollback SHA.
- После любого rollback повторно запустить staging smoke и зафиксировать platform SHA, repository SHA/checksums каждой затронутой сцены, причину и список вручную мигрированных test rooms.
- Автоматический rollback workflow обязан использовать operator catalog-restore path до смены image; если API недоступен, тот же idempotent SQL выполняется локально на staging host. Rollback прекращается с ошибкой, если target SHA не совпадает с immutable `wave2-rollback-sha`; общий current-successful marker не является допустимой заменой.
