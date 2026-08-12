# План: тёплая современная meeting room, A/B и AI Scene Factory

Дата: 2026-08-12.

Статус: дизайн подхода согласован, реализация Stage 0 начата 2026-08-12.

Этот документ дополняет `docs/plans/2026-08-04-standard-room-templates.md` и заменяет только подход к созданию и визуальной приёмке новых room assets. Platform contracts, immutable template binding, Wave 2/3 activation, runtime ownership rules и Scene Bundle v1 остаются без изменений.

## Совместимость с FEAT-032

- Пилот на 8 человек является review-only experiment и не является прямым asset для `meeting-room-basic@1.0.0`.
- Родительский FEAT-032 contract остаётся рассчитанным на 2-4 participants и четыре обязательных места. Адаптация выбранного art direction к этому contract выполняется отдельным candidate/version после A/B.
- Для обеих review rooms обязательны surfaces `debug-main` и `whiteboard-wall`; формулировка «при необходимости» не применяется.
- Один успешный meeting-room pilot не разрешает Wave 3 activation. До activation по-прежнему нужны утверждённые personal, meeting и presentation scenes и все gates родительского плана.
- Если product decision изменит `meeting-room-basic@1.0.0` на 8-seat contract, сначала отдельным review обновляется родительский план и template contract. Asset authoring не меняет platform contract молча.

## Зафиксированные решения

| Решение | Статус |
|---|---|
| `meeting-room-review-v2`, `personal-workspace-review-v2` и `presentation-room-review-v2` не являются утверждённым art direction | Принято |
| Не продолжать косметически улучшать процедурные сцены из примитивов | Принято |
| Первым новым пилотом сделать meeting room на 8 человек | Принято |
| Визуальное направление: тёплый современный офис с деревом, дневным светом и функциональной детализацией | Принято |
| Сравнить две полноценные независимо спроектированные комнаты: A, curated CC0; B, AI Scene Factory | Принято |
| Общими для A/B оставить функциональный brief и технические ограничения, но не архитектуру, материалы или furniture layout | Принято |
| AI Scene Factory проектирует всю комнату, а не только отдельные props | Принято |
| Комнату собирать структурированными слоями, не генерировать одним монолитным mesh | Принято |
| До слепого сравнения не смешивать A/B; гибрид C собирать только после раскрытия результатов | Принято |
| Фабрику и исследование вести в отдельном pilot repository, не смешивая с platform или другими asset projects | Принято |
| Каждую сцену вести в отдельном repository; общий multi-scene assets repository для новых candidates не использовать | Принято |

## Repository isolation contract

Пилот использует четыре изолированных контура и не добавляет новый контент в существующий `vrata-labs/scene-assets`:

| Контур | Repository | Что хранит | Что запрещено |
|---|---|---|---|
| Platform | `vrata-labs/platform` | Platform contracts, runtime/API integration и этот plan/evidence links | Scene Factory code, scene sources и pilot bundles |
| Experiment / Scene Factory | `vrata-labs/warm-modern-meeting-room-scene-factory` | Общий brief, style bible, schemas, compiler, fairness protocol, cross-track reports и immutable candidate locks | Scene source files, release GLB и использование repository для другого room project |
| Candidate 01 | `vrata-labs/warm-modern-meeting-room-candidate-01` | Ровно одна сцена: source, track-specific provenance, build scripts и immutable releases | Вторая сцена, cross-track research или reusable factory implementation |
| Candidate 02 | `vrata-labs/warm-modern-meeting-room-candidate-02` | Ровно одна сцена: source, track-specific provenance, build scripts и immutable releases | Вторая сцена, cross-track research или reusable factory implementation |

`candidate-01` и `candidate-02` являются production identifiers, а не review labels. Они не определяют mapping `Alpha`/`Beta`; mapping по-прежнему назначается случайно только после freeze. Reviewers не получают repository access/navigation instructions до сдачи scorecards.

Cross-repo integration выполняется только по полным commit SHA и checksums. Git submodules, Git subtree, vendoring Scene Factory в scene repositories и копирование scene source/release binaries между repositories запрещены. Каждый scene repository имеет собственные `platform-validator.lock`, manifest, CI, immutable release history и provenance ledger. Experiment repository хранит только lock record на exact scene commits и checksums.

Существующий `vrata-labs/scene-assets` остаётся immutable историей уже опубликованных multi-scene candidates и compatibility releases. Новый pilot не создаёт в нём branches, source directories, release paths или aggregate PR.

## Цель

- Получить две визуально полноценные warm-modern meeting rooms, пригодные для честного blind A/B review в реальном Vrata runtime.
- Проверить, может ли curated CC0 pipeline дать production-quality room без проприетарных assets.
- Проверить, может ли воспроизводимая AI Scene Factory проектировать архитектуру, материалы, освещение, окружение, furniture и props с приемлемым качеством и объёмом ручной доработки.
- Собрать минимальный pilot-specific Scene Factory repository, который сохраняет brief, style bible, schemas/compiler, model run metadata и cross-track метрики; scene-specific provenance и accepted source outputs остаются только в repository соответствующей сцены.
- Получить данные для выбора art direction и, только после одинакового shipping-budget pass обоих tracks, данные для выбора production pipeline.
- Сформировать обоснованный follow-up для personal/presentation rooms без преждевременной productization Scene Factory.

## Terminal outcomes и критерии готовности

Исследование заканчивается одним из явно названных исходов.

### `FEASIBILITY_STOP`

- AI rights, compute или второй time-boxed model probe gate не пройден.
- Сохранены evidence, затраты, probe artifacts policy и stop report.
- Результат не называется завершённым A/B и не используется как доказательство превосходства Track A.
- Track A может продолжаться отдельной asset-production задачей, но не как часть сравнительного пилота.

### `AB_ART_COMPLETE`

- Опубликованы два immutable review bundles, каждый из собственного scene repository и собственного полного commit SHA; experiment lock фиксирует оба SHA, checksums и единый platform-validator SHA.
- Оба варианта независимо реализуют всю комнату: shell, стены, потолок, пол, окно, вид из окна, дверь и косяки, плинтусы, архитектурные детали, материалы, lighting, furniture и props.
- Обе комнаты выполняют одинаковый review-only functional contract на 8 человек и имеют `main`, восемь seats, `debug-main` и `whiteboard-wall`.
- Для обеих веток сохранены cleared source files, rights/provenance ledger, active production time и технические метрики.
- AI-ветка сохраняет exact model/code/weights revisions, licenses, prompts, seeds, cleared input IDs, accepted raw outputs, generation attempts, rejection reasons и cleanup time.
- Обе комнаты проходят static GLB/Scene Bundle validation и достигают `sceneBundleState=loaded`, `sceneDebug.state=loaded`, `sceneDebug.failureReason=null`, `sceneDebug.missingAssets=[]`.
- Подготовлены одинаковые semantic review views и короткие walkthroughs.
- Проведён controlled blind visual review под именами `Alpha` и `Beta` по утверждённому fairness protocol.
- Составлен art report с visual score, runtime metrics, затратами времени, AI yield и art-direction verdict.

### `AB_ART_STOP`

- AI feasibility gate был пройден, но один из tracks достиг active-time cap, получил rights failure или не прошёл art/runtime hard gate до готовности двух сопоставимых bundles.
- Сохранены evidence, frozen partial artifacts и причины остановки.
- Visual winner и production-pipeline winner не объявляются. Допустим только qualitative список сильных/слабых сторон готовых частей.

### `AB_SHIPPING_COMPLETE`

- Выполнены все условия `AB_ART_COMPLETE`.
- Оба tracks независимо оптимизированы под один combined `mobile-lite`/XR contract.
- Оба shipping candidates прошли одинаковые static/runtime/device gates.
- Составлен production report и допустим verdict о выборе pipeline: `A`, `B`, `hybrid follow-up` или `stop`.

### `AB_SHIPPING_STOP`

- `AB_ART_COMPLETE` достигнут, но один или оба tracks не прошли equal shipping-budget, runtime или physical-device gate.
- Art-direction verdict сохраняется.
- Production-pipeline superiority не объявляется; production verdict равен `stop` либо требует нового scoped experiment.

Ни один из outcomes не активирует product template автоматически.

## Definition of Ready

До начала зависимого stage должны быть записаны:

- URL и base SHA experiment repository и двух single-scene repositories, branch/CI/release permissions и immutable publish path каждого scene repository;
- full-SHA CDN shape, CORS/content types/cache behavior и release credentials readiness без публикации секретов;
- pinned platform-validator SHA и доступная exact Blender `4.5.12 LTS` build;
- GPU provider, region, machine/image, budget cap, billing owner и teardown owner;
- назначенный human rights owner и завершённый AI/provider rights review;
- staging room/admin access для двух review rooms;
- review coordinator и список reviewers, не участвовавших в production, либо явная пометка single-reviewer qualitative mode;
- владельцы физических Android, iOS и Meta Quest checks и ожидаемые даты доступности;
- storage location, quota, retention и deletion policy для references, accepted/rejected generation outputs и source binaries;
- правило, какие reference images разрешены для human-only moodboard, а какие разрешены как model inputs.

Отсутствующая зависимость блокирует только зависящий от неё stage. External wait учитывается отдельно от active work estimate.

### Текущая готовность

| Зависимость | Состояние на 2026-08-12 | Следующее действие |
|---|---|---|
| Existing multi-scene repository | `vrata-labs/scene-assets`, main SHA `9ea73bc1a1ed0e86d5d959738d0383ccf89ad464` | Использовать только как historical reference; pilot artifacts не добавлять |
| Experiment / Scene Factory repository | `vrata-labs/warm-modern-meeting-room-scene-factory`, initial SHA `8ce3ddfb9b0ddf90d9960d168961af2eb3b37569`, CI `31635983923` green, `main` protected | Продолжать через PR после platform docs sync |
| Candidate 01 repository | `vrata-labs/warm-modern-meeting-room-candidate-01`, initial SHA `1805c148866e8aeb8d21cb827bc93968bd61769c`, CI `31635584774` green, `main` protected | Не добавлять assets до rights/reference gates |
| Candidate 02 repository | `vrata-labs/warm-modern-meeting-room-candidate-02`, initial SHA `6a8ec35fca968522e8041c1034f66bca6032aa9e`, CI `31635604223` green, `main` protected | Не добавлять assets до rights/reference gates |
| Platform validator | Pinned SHA `4ae8951961fce72a16f87b9d15890aee7d7eef2d` | Подтвердить, что lock не устарел перед implementation |
| Blender | Linux `4.5.12 LTS`, archive SHA-256 `95e3a2dfedba3bd32ca54fc355eac6b15a11986954ccb02815a07535d0120a25`, binary SHA-256 `33ac108ebce3c271f5357e5c664d0488717263bcf2145c80300edd0b12c31880`, build `84afd5f785f7` | Использовать exact verified build |
| Local GPU | GTX 1060 6 GB, недостаточно для TRELLIS | Выбрать disposable 16+ GB GPU |
| GPU provider/budget | Не выбраны | Назначить billing/teardown owner и cap до Stage 2 |
| Human rights owner | Не назначен | Назначить до model/provider review |
| Reviewers | Не назначены | Найти трёх non-author reviewers либо зафиксировать qualitative single-reviewer mode |
| Physical devices | Доступность не подтверждена для нового пилота | Назначить Android/iOS/Quest owners до shipping pass |
| Experiment storage | Не выбрано | Утвердить quota/retention/deletion policy до Stage 1 и до скачивания/copy raw references |
| Staging review access | 2026-08-12 green: `/health`, demo room, control plane и authenticated control-plane session | Не создавать review rooms до появления published candidates |

Public `scene-assets` repository уже существует, но новый isolation contract запрещает использовать его как container для новых сцен. В Stage 0 родительская документация должна быть скорректирована: factual prerequisite создания общего repository закрыта исторически, а все новые original scenes получают отдельные repositories. Platform contracts, immutable bindings и activation state не меняются.

## Не-цели

- Не активировать Wave 3 и не менять current product template bindings в рамках A/B.
- Не удалять и не изменять опубликованные immutable `review-v2` releases; они остаются историей неудачного art approach.
- Не копировать SenseTower geometry, textures, screenshots, source files, layouts, trade dress или private URLs. Авторы и модели пилота работают только с утверждёнными public-safe references. Private benchmark разрешён только после freeze A/B для общей оценки quality gap и не используется как model input или design reference.
- Не использовать assets с неясной лицензией, marketplace Standard/Editorial licenses или запретом на redistribution в публично скачиваемом GLB.
- Не строить drag-and-drop scene editor, marketplace, tenant asset generator или постоянный GPU service в пилоте.
- Не делать универсальный архитектурный CAD/BIM editor.
- Не генерировать всю комнату одним неструктурированным mesh, NeRF или Gaussian Splat и не использовать такой output как collision/navigation geometry.
- Не маскировать неудачу AI-ветки полноценным ручным художественным перемоделированием.
- Не начинать personal и presentation room art pass до решения по meeting-room A/B.
- Не объявлять Scene Factory reusable platform после одной комнаты. Productization рассматривается только после повторного применения минимум ко второй room type.

## Утверждённый creative brief

### Назначение и масштаб

- Meeting room на 8 человек.
- Ориентир размера: `7.0 x 5.0 x 3.1 m`; допустима корректировка в пределах 10%, если это улучшает эргономику и композицию.
- Один основной вход, одно крупное окно, один основной presentation display.
- Безопасный проход от входа к любому seat и к presenter/display zone.
- Реальный eye-level review с высоты около `1.6 m`, а не только beauty camera сверху.

### Визуальный язык

- Тёплый дуб, светлая минеральная штукатурка, графитовый металл.
- Песочная и приглушённая серо-зелёная ткань.
- Большое окно с правдоподобным профилем, откосами и внешним окружением.
- Дневной свет плюс архитектурный и подвесной свет `2700-3000 K`.
- Функциональные acoustic treatments, а не случайные декоративные рейки.
- Правдоподобная конструкция стола, кресел, двери, окон, светильников и wall assemblies.
- Видимые плинтусы, косяки, дверная фурнитура, ventilation details, cable management, power/data points и screen hardware.
- Умеренная бытовая плотность: блокноты, стаканы, charging points, conference device, кабели, несколько растений и небольшая асимметрия.

### Антицели

- Мебель из кубов и трубок без конструктивной логики.
- Золотые декоративные элементы, неон и sci-fi language.
- Зеркальная симметрия и пустые showcase walls.
- Один bevel/roughness/material treatment для всех объектов.
- Декор без функции, чрезмерное количество реек или случайные формы на потолке.
- Плоский фон за окном, который выглядит как наклеенная картинка с обычных viewing positions.

## Контракт A/B

### Что одинаково

- Creative brief и room purpose.
- Вместимость и минимальные clearance/ergonomic требования.
- Один вход, одно крупное окно, display/presenter zone.
- Runtime IDs и contract: `main` spawn, восемь seat anchors, `debug-main` и `whiteboard-wall`.
- Четыре review viewpoints: entry, participant, presenter, diagonal overview.
- Static/runtime validation rules.
- Art comparison profile и production optimization target.
- Формат отчёта, time tracking и rights checks.

### Что независимо

- Floor/wall composition внутри допустимого room envelope.
- Window, door, ceiling и trim design.
- Material palette implementation и texture selection/creation.
- Exterior treatment.
- Lighting composition и fixture design.
- Furniture forms, prop selection и detail language.
- Asset production method и assembly process.

### Track A: Curated CC0

- Создать ровно три low-fidelity whole-room concepts до выбора final room design.
- Использовать реальные room references и floor-plan logic без копирования защищённого интерьера целиком.
- Искать meshes/HDRIs/materials только в заранее разрешённых источниках.
- Для первого пилота предпочитать CC0; CC-BY добавлять только после отдельной проверки attribution/redistribution contract.
- Базовые источники: Poly Haven, ambientCG, CC0 subset Blendkit, явно отмеченные Public Domain/CC0 libraries Sweet Home 3D.
- Manufacturer CAD/BIM использовать только как dimensional reference, если лицензия явно не разрешает redistribution изменённого model file.
- Допускается техническая cleanup: scale, pivot, UV fixes, material consolidation, retopology, LOD, collision и texture compression.
- Любая художественная модификация стороннего asset должна сохранять provenance исходника и условия лицензии.

### Track B: AI Scene Factory

- Создать ровно три оригинальных low-fidelity whole-room concepts по creative brief.
- Преобразовать утверждённый concept в structured scene specification: plan, wall elevations, openings, material zones, ceiling system, lighting plan, environment и components.
- Скомпилировать архитектурную оболочку из спецификации в Blender.
- Генерировать или параметрически собирать architectural modules: windows, doors, frames, trims, columns, ceiling elements, panels и built-ins.
- Генерировать major furniture/fixtures/props по согласованным concept images и реальным размерам.
- Плановые component families: conference table, task chair, pendant luminaire, credenza/storage, conference AV set, laptop/stationery set, planter/container, acoustic module и power/cable-management fixtures.
- Разрешить базовую cleared PBR substrate library, но AI-ветка обязана создать собственную согласованную palette и material recipes, а не скопировать финальные materials Track A.
- Допускать только technical cleanup generated assets: удалить артефакты, закрыть holes, retopology, UV/PBR correction, scale, pivot, LOD, collision и texture compression.
- Не выполнять ручной sculpt/remodel, который меняет художественную форму generated asset. Если без него asset непригоден, asset считается rejected.

### Защита сравнения от bias

- Это controlled single-brief comparison, а не статистический A/B-test и не доказательство универсального превосходства pipeline.
- До freeze A/B не переносить финальные meshes, material recipes или composition decisions между ветками.
- One-time factory setup учитывать отдельно от recurring room production time.
- Equal active-human-time cap фиксировать только после AI feasibility spike по измеренным search/generation/cleanup rates, а не заранее.
- В active cap включать search, prompting, generation monitoring, failed attempts, cleanup, assembly и reruns. GPU wall time, queue time, one-time setup и recurring work публиковать отдельно для обоих tracks.
- Generation attempts и search attempts логировать, не скрывать неудачные варианты. Raw rejected binaries могут храниться вне public Git согласно retention policy.
- После freeze review coordinator, не участвовавший в production, случайно назначает mapping `Alpha`/`Beta` и сохраняет его в недоступном reviewers mapping record.
- Review-visible room URL, room label, manifest label и HUD не должны раскрывать track. Reviewer не открывает provenance repository или diagnostics metadata до сдачи scorecard.
- Минимум три reviewers, не участвовавших в production, независимо оценивают варианты в случайном порядке. Если доступен только один reviewer, результат маркируется `qualitative expert review` и не используется как обобщённое доказательство превосходства pipeline.
- Для review записать оба scene-repository SHA, experiment SHA, platform SHA, camera transforms, FOV, viewport, DPR, exposure, cold/warm cache mode и порядок показа.
- После art scorecards mapping остаётся закрытым, пока не решено, выполнять ли shipping comparison. Если experiment заканчивается на `AB_ART_COMPLETE`, mapping раскрывается после art scorecards. Если выбран shipping comparison, mapping раскрывается только после shipping scorecards.
- Любой review после раскрытия mapping маркируется non-blind и не используется как unbiased visual evidence выбора pipeline.
- Разница меньше 5 итоговых points считается visual tie. Tie решается не повторным субъективным голосованием, а shipping metrics, rights и recurring production effort.
- После раскрытия разрешить вариант C только как отдельный результат, а не как подмену исходного A/B.

## Минимальная AI Scene Factory

Pilot scope ограничен exact warm-modern meeting-room specification и отдельным dedicated repository. Generic component registry, reusable profile framework, stable public CLI, content-addressed generation cache и GPU job runner не входят в pilot Definition of Done.

### Артефакты

Experiment / Scene Factory repository хранит:

```text
experiment/warm-modern-meeting-room/
  brief.md
  style-bible.json
  concepts/                 # только cleared small evidence files
  scene-spec.schema.json
  candidate-lock.json       # repo + full SHA + release checksums, без binaries
  reports/
    static-metrics.json
    runtime-metrics.json
    scorecard.md
schemas/
compiler/
scripts/
```

Каждый single-scene repository хранит только собственный контент:

```text
source/
provenance/
  asset-ledger.json
  generation-ledger.json    # только для AI track
assets/scenes/<candidate-scene-id>/<version>/
  scene.json
  scene.glb
  preview.webp
  LICENSES.md
manifest.json
platform-validator.lock
```

Pilot paths фиксированы как `experiment/warm-modern-meeting-room/`, `schemas/`, `compiler/` и `scripts/` в Scene Factory repository. Generated release outputs используют immutable `assets/scenes/<scene-id>/<version>` contract только в repository соответствующей сцены. Large raw attempts и restricted human-only references не хранятся ни в одном public Git repository.

### Style bible

`style-bible.json` фиксирует минимум:

- color palette в linear/sRGB-safe values;
- wood species/tone и grain scale;
- metal finish;
- fabric colors и weave scale;
- trim widths, wall thicknesses и common radii;
- ceiling module rhythm;
- window/door profile language;
- roughness/metalness ranges;
- light color temperature и contrast target;
- запрещённые формы, materials и branded motifs.

### Scene specification

`scene-spec.json` описывает:

- room polygon, floor/ceiling levels и wall thickness;
- doors/windows с dimensions, placement и profile IDs;
- wall/floor/ceiling material zones;
- trims, reveals, niches, columns, acoustic panels и built-ins;
- light fixtures и intended contribution;
- exterior/background strategy;
- component instances, dimensions, transforms и source/generation recipe;
- walkable clearance, spawn, seats и media surfaces;
- generation seed, exact generator revision и accepted input artifact hashes как provenance, без обещания повторить stochastic generation byte-for-byte.

JSON schema и validator должны отклонять non-finite dimensions, overlapping/invalid openings, missing material recipes, unknown component IDs, out-of-bounds anchors и отсутствующий provenance record.

### Architecture compiler

- Реализуется только после green AI feasibility gate и только для approved pilot specification.
- Получает только approved scene specification.
- Создаёт walls с thickness и корректными joins, а не one-sided planes.
- Вырезает openings и добавляет frames, reveals, sills, trims и hardware anchors.
- Создаёт floor/ceiling assemblies и UV scale в метрах.
- Размещает modular architectural details и material zones.
- Сохраняет meaningful object/material names.
- Не принимает самостоятельных aesthetic decisions вне specification.
- Использует pinned Blender `4.5.12 LTS` и записывает generator version.
- Детерминированный downstream build начинается от content-addressed accepted raw AI outputs; повторная AI generation не является частью bundle reproducibility.

### Concept и 3D generation

- Для concept images базовый кандидат: `FLUX.1-schnell`; model card заявляет Apache-2.0, но это не заменяет полный AI rights gate.
- Для image-to-3D базовый кандидат: `microsoft/TRELLIS-image-large`; model card заявляет MIT, но это не заменяет проверку weights, dependencies и provider terms.
- TRELLIS требует не менее 16 GB VRAM; текущая GTX 1060 6 GB недостаточна.
- Предпочтительный путь для publishable output: self-host exact model revisions на disposable raw GPU instance. Hosted demo/API можно использовать только после отдельной проверки output/export, retention и training terms.
- `Hunyuan3D 2.1` не использовать: community license исключает EU, UK и South Korea и ограничивает использование outputs вне разрешённой территории.
- Любая замена модели требует записанного model/license review до генерации publishable artifacts.
- Для каждого run закреплять repository commit, weights revision/checksum, container digest, dependency lock, CUDA/runtime versions и provider region.

### Asset processing

- Нормализовать единицы до метров и orientation до Vrata conventions.
- Устанавливать gameplay-friendly pivots.
- Удалять hidden helpers, cameras, test geometry и oversized background meshes.
- Выполнять measured retopology/simplification, а не фиксированный destructive preset.
- Формировать LOD/collision только после визуального acceptance high-quality source.
- Использовать glTF PBR и корректные color spaces.
- Проверять generated normals, UV seams, texture bleeding, glass и thin surfaces в Three.js runtime.
- Хранить original, cleaned source и published output раздельно.

## Rights и provenance

### AI rights gate

До первой publishable generation назначенный human rights owner отдельно подтверждает:

- exact code license;
- exact weights/model license;
- licenses transitive runtime/generation dependencies;
- provider Terms of Service с датой и сохранённой копией;
- commercial-use и redistribution rights для outputs внутри публично скачиваемого GLB;
- input retention, training, privacy и deletion policy;
- territorial restrictions;
- допустимость production use при возможном отсутствии copyright, exclusivity или non-infringement warranty.

Repository license или model card сами по себе не считаются output clearance. Неясное или недоказанное условие является hard failure. В model inputs допускаются только internal-original или CC0 materials с подтверждённым правом на ML processing и derivative redistribution. Остальные references используются только человеком и не загружаются в модель.

### Asset ledger

Каждый mesh, texture, HDRI, image reference и generated output должен иметь ledger entry:

- stable asset ID;
- track A/B;
- public source URL или public-safe repository-relative source ID; absolute/private local paths запрещены;
- author/provider;
- license name и сохранённый license reference;
- download/generation date;
- original checksum;
- allowed use: staging, production, web runtime, screenshots, optimization, redistribution;
- modifications и tool versions;
- output checksums;
- attribution text, если требуется;
- для AI: code/weights/dependency/provider license refs, exact revisions/digests, prompt, seed, input asset IDs и rejected/accepted status.

Hard failures:

- неизвестная или недоказанная лицензия;
- Standard/Editorial marketplace asset без явного права публиковать extractable GLB;
- private SenseTower input;
- branded/copied product с высоким риском trade dress infringement;
- AI input, который сам не разрешён для derivative generation;
- отсутствующий provenance chain для published file.

### Storage и retention

- Experiment Git хранит common specifications, factory scripts, small cleared evidence и cross-track reports без scene binaries.
- Каждый scene Git хранит только собственные ledgers, accepted cleared source artifacts и published bundle; scene artifacts нельзя агрегировать в experiment, platform или другой scene repository.
- Human-only references, uncleared inputs и raw rejected attempts не попадают в public Git.
- External/private experiment storage до generation получает owner, quota, encryption/access policy, retention period и deletion procedure.
- Ledger может хранить checksum и rejection reason удалённого attempt без самого binary.
- Accepted raw AI output становится content-addressed immutable source downstream cleanup/export pipeline; его location и retention должны переживать published release.
- Provider-side input/output deletion и прекращение billing подтверждаются отдельным teardown record.

## Performance profiles

### Art comparison profile

Цель A/B сначала сохранить визуальное качество, но не разрешать бесконтрольный desktop-only asset:

- target bundle/GLB: не более 25 MB;
- hard maximum: `desktop-standard` 40 MB;
- target runtime triangles: не более 150k;
- hard maximum: 220k;
- target meshes: не более 300;
- target textures: не более 64;
- desktop staging cold load target: не более 15 секунд;
- первый кадр читаемый без debug material overrides.

### Production candidate gate

Blind art review выбирает только art direction. Вывод о production pipeline допустим только после независимого shipping pass обоих tracks. Каждый shipping candidate должен:

- пройти combined `mobile-lite`/XR budget из `docs/scene-technical-requirements.md`;
- иметь bundle и GLB не более 15 MB;
- иметь не более 90k runtime triangles, 500 objects, 250 meshes, 96 materials и 48 textures;
- иметь staging cold load не более 20 секунд;
- пройти desktop, physical Android, physical iOS и Meta Quest review;
- получить повторный visual score после optimization при одинаковых review settings.

Если оптимизирован только visual winner, результат ограничивается выбором art direction и не доказывает преимущество production pipeline. Если quality collapse неизбежен при single-bundle limits, activation остаётся заблокированной. Поддержка quality-specific bundles оформляется отдельной runtime/platform задачей, а не скрытым исключением validator.

## Этапы и задачи

### Этап 0. Зафиксировать эксперимент

- [x] [1-2ч] Создать отдельные experiment/factory, Candidate 01 и Candidate 02 repositories; initial SHA, visibility, permissions и owner записаны в experiment readiness.
- [x] [1ч] Добавить repository isolation contract и ссылку на этот план в experiment README; scene READMEs ссылаются только на common contract и не содержат cross-track artifacts.
- [x] [1ч] Добавить в каждый scene repository automated boundary check, отклоняющий второй scene ID/release root, и независимый `platform-validator.lock`.
- [x] [1ч] Включить branch protection и required `validate` check независимо во всех трёх repositories.
- [ ] [1-2ч] Заполнить Definition of Ready: accesses, roles, exact tool revisions, provider, storage, devices и external waits.
- [x] [1ч] Проверить release credentials readiness, full-SHA CDN URL, CORS, content types и cache behavior на существующем cleared fixture.
- [x] [1ч] Отдельным docs-only platform commit отметить historical `vrata-labs/scene-assets` и новое правило one-scene-one-repository, не меняя FEAT-032 platform contracts или activation state.
- [x] [1ч] Подтвердить exact Scene Factory paths `experiment/warm-modern-meeting-room/`, `schemas/`, `compiler/`, `scripts/`; scene source/release paths существуют только в single-scene repositories.
- [x] [1ч] Создать neutral experiment IDs и зарезервировать opaque labels `Alpha`/`Beta`; mapping не назначен до freeze обоих art candidates.
- [x] [1-2ч] Зафиксировать exact functional contract: room envelope, 8 seat anchors, spawn, surfaces, clearance и four review viewpoints.
- [x] [1-2ч] Создать anchored visual scorecard, fairness protocol и time/yield report templates до начала art work.
- [ ] [1ч] Записать compute budget/cap и teardown rule для disposable GPU.

Условие перехода: brief, scorecard, A/B rules и compute cap committed; reference handling/storage boundary green; нет незакрытых вопросов о том, что сравнивается.

Stage 0 evidence на 2026-08-12:

- experiment initial SHA `8ce3ddfb9b0ddf90d9960d168961af2eb3b37569`, readiness merge `b39f10bc4300f9a4e4ced9fc0ec695d85fa2c03d`, CI runs `31635983923`, `31636405182`, `31636576720` green;
- Candidate 01 initial SHA `1805c148866e8aeb8d21cb827bc93968bd61769c`, CI `31635584774` green;
- Candidate 02 initial SHA `6a8ec35fca968522e8041c1034f66bca6032aa9e`, CI `31635604223` green;
- все три `main` защищены strict required check `validate`, admin enforcement, запретом force-push/delete и обязательным conversation resolution;
- official Blender `4.5.12 LTS` verified: archive SHA-256 `95e3a2dfedba3bd32ca54fc355eac6b15a11986954ccb02815a07535d0120a25`, binary SHA-256 `33ac108ebce3c271f5357e5c664d0488717263bcf2145c80300edd0b12c31880`, build `84afd5f785f7`;
- full-SHA jsDelivr fixture подтвердил CORS `*`, JSON/GLB content types, immutable one-year cache и exact checksums; full-SHA URLs всех трёх новых repositories доступны;
- staging access повторно проверен: health, demo room, control plane и authenticated control-plane session доступны;
- подтверждён отложенный platform integration gap: текущий FEAT-032 checkout/validator использует один `scene-assets.lock`, а URL resolver принимает один base URL и relative path; A/B review rooms не блокируются, потому что используют direct immutable `sceneBundleUrl`, но product adaptation обязана перейти на per-scene repository/SHA locks и cross-repo validation до Wave 3;
- переход к Stage 1/2 заблокирован до назначения restricted storage, human AI rights owner, GPU provider/budget/billing/teardown owners; Stage 0 в целом остаётся открытым из-за этих DoR полей и compute cap.

### Этап 1. Style bible и references

Stage 1 не начинается, пока утверждены reference handling policy и storage boundary. Public Git может хранить только URLs, metadata и cleared redistributable evidence. Raw human-only references хранятся только в утверждённом restricted storage. Model-input classification фиксируется до скачивания или копирования файла.

- [ ] [2-3ч] Найти 12-20 warm-modern room references и записать source/usage classification.
- [ ] [1-2ч] Отфильтровать branded/distinctive interiors и references с неприемлемыми rights для AI conditioning.
- [ ] [2-3ч] Собрать moodboard по отдельным категориям: architecture, windows/doors, ceiling, materials, furniture, lighting, exterior и lived-in detail.
- [ ] [1-2ч] Сформировать `style-bible.json` с palette, dimensions, profiles, roughness и anti-patterns.
- [ ] [1-2ч] Сделать human-readable style sheet с примерами допустимых и запрещённых решений.
- [ ] [1ч] Провести art-direction gate до моделирования.

Условие перехода: пользователь утверждает один style bible; последующие изменения записываются как decision, а не вносятся молча в одну ветку.

### Этап 2. AI rights и feasibility spike

- [ ] [2-3ч] Назначенному rights owner проверить code, weights, dependencies, provider ToS, output rights, input retention/training, territories и redistribution в extractable GLB.
- [ ] [1ч] Сохранить dated rights verdict и запретить generation при любом unresolved hard-failure field.
- [ ] [1-2ч] Утвердить storage quota/retention/deletion policy и разделение public/private artifacts.
- [ ] [1-2ч] Выбрать disposable 16+ GB GPU path, зафиксировать provider/region/image/container/CUDA/cost cap и teardown procedure; не создавать постоянную инфраструктуру.
- [ ] [2-3ч] Self-host pinned FLUX.1-schnell concept generation и сохранить exact code/weights/dependency/license evidence.
- [ ] [2-3ч] Self-host pinned TRELLIS image-to-3D export на одном simple fixture и сохранить exact code/weights/dependency/license evidence.
- [ ] [1-2ч] Подготовить ergonomic-chair probe с cleared input и functional dimensions.
- [ ] [2-3ч] Выполнить максимум три chair attempts, permitted cleanup и close-range Blender/runtime review.
- [ ] [1-2ч] Подготовить window/trim assembly probe с cleared input и architectural dimensions.
- [ ] [2-3ч] Выполнить максимум три window attempts, permitted cleanup и close-range Blender/runtime review.
- [ ] [1-2ч] Подготовить pendant-fixture probe с cleared input и lighting dimensions.
- [ ] [2-3ч] Выполнить максимум три pendant attempts, permitted cleanup и close-range Blender/runtime review.
- [ ] [1-2ч] Составить spike verdict с accepted/rejected hashes, cleanup minutes, model/runtime metrics и costs.
- [ ] [1-2ч] Выполнить короткую Track A search/import/cleanup calibration на одной сопоставимой component family.
- [ ] [1ч] По business time budget и measured A/B rates установить одинаковый active-human-time cap и пересчитать forecast с резервом; AI rates не определяют cap единолично.
- [ ] [1ч] Зафиксировать counted production work и одинаково исключённые validation/publication tasks. При достижении cap track немедленно freeze; extension после просмотра другого track запрещён, incomplete track даёт `AB_ART_STOP`.
- [ ] [1ч] Проверить, что accepted probe outputs/evidence перенесены в durable storage, checksums совпадают с ledger и teardown не удалит данные gate/stop report.
- [ ] [1ч] Выполнить teardown instances, volumes, snapshots, temporary buckets и credentials; подтвердить прекращение billing.

AI feasibility gate:

- минимум 2 из 3 probes проходят visual/technical review;
- accepted probe требует не более 45 минут cleanup;
- output можно уменьшить до разумного budget без разрушения silhouette;
- полный AI rights gate и provenance chain достаточны для публичного review bundle;
- полный AI track не начинается, если gate не пройден.

Если gate не пройден, допускается один time-boxed spike альтернативной permissive model. После второй неудачи фиксируется `FEASIBILITY_STOP`; ручная подмена запрещена.

### Этап 3. Pilot-specific scene-lab scaffold

- [ ] [1-2ч] Создать минимальный Scene Factory layout в dedicated repository без отдельного сервиса, database или generic registry.
- [ ] [2-3ч] Добавить exact pilot schema/validator для `scene-spec.json` и asset/generation ledger.
- [ ] [1-2ч] Добавить negative fixtures: invalid dimensions/openings, missing license, unknown component, invalid anchor и non-finite transform.
- [ ] [1-2ч] Реализовать parsing approved pilot specification и stable diagnostics.
- [ ] [2-3ч] Реализовать room-specific Blender shell: floor, ceiling и walls с thickness/joins.
- [ ] [2-3ч] Реализовать openings: door/window cuts, frames, reveals и sills.
- [ ] [2-3ч] Реализовать trims/profile placement и meter-scale UV/material zones без decorative auto-design logic.
- [ ] [1-2ч] Добавить compiler tests и reproducibility report: specification hash, accepted input hashes, Blender/container revisions и output hash/stats.
- [ ] [1-2ч] Проверить два consecutive exports из одних accepted inputs; final GLB должен быть byte-identical до publication.

Условие перехода: exact pilot specification воспроизводит byte-identical GLB и проходит existing validators. Если pinned Blender/exporter даёт разные bytes, publication блокируется до локализации nondeterminism или добавления deterministic canonicalization step с отдельными tests; неопределённая `structural equivalence` не принимается. Повтор stochastic AI generation не требуется и измеряется отдельно.

### Этап 4A. Curated CC0 room

- [ ] [2-3ч] Создать ровно три low-fidelity Track A whole-room concepts по approved style bible.
- [ ] [1ч] Провести anonymous concept gate и выбрать один Track A design до detailed asset search.
- [ ] [2-3ч] Создать Track A room plan/elevations на основе approved brief и реальных эргономических размеров.
- [ ] [1ч] Зафиксировать Track A assignment на один neutral candidate repository; не копировать его source или release artifacts в experiment repository.
- [ ] [2-3ч] Собрать shortlist architecture/material/environment assets только из разрешённых источников.
- [ ] [2-3ч] Собрать shortlist furniture/fixture/prop assets и заполнить ledger до импорта.
- [ ] [2-3ч] Создать architecture shell с окнами, дверью, trims, ceiling и material zones.
- [ ] [2-3ч] Выполнить primary furniture/layout pass с восемью реальными clearance zones.
- [ ] [2-3ч] Выполнить architectural detail pass: frames, hardware, HVAC, power/data и cable routes.
- [ ] [2-3ч] Выполнить material pass с real-world texture scale и согласованной palette.
- [ ] [2-3ч] Выполнить lighting/exterior pass и проверить entry/participant views.
- [ ] [2-3ч] Добавить restrained lived-in props и устранить showroom symmetry.
- [ ] [1-2ч] Получить pre-freeze human rights sign-off всех accepted Track A meshes, textures, references и modifications.
- [ ] [1-2ч] Заморозить art version A до cross-track review.

### Этап 4B. AI-designed room

- [ ] [1-2ч] Создать новую disposable GPU instance из проверенного pinned image и подтвердить remaining cost cap.
- [ ] [1ч] Повторно проверить exact model/provider terms и revision drift с момента feasibility spike; при изменении вернуть rights gate.
- [ ] [1-2ч] Настроить durable content-addressed ingestion: каждый accepted raw output копируется и проверяется до удаления temporary artifact.
- [ ] [2-3ч] Сгенерировать ровно три low-fidelity whole-room concepts по одному style bible и сохранить prompts/seeds.
- [ ] [1ч] Провести anonymous concept gate и выбрать один design без заимствования композиции Track A.
- [ ] [2-3ч] Разложить concept на floor plan, wall elevations, ceiling plan, material zones, lighting и exterior strategy.
- [ ] [2-3ч] Записать и провалидировать `scene-spec.json`.
- [ ] [1ч] Зафиксировать Track B assignment на второй neutral candidate repository; accepted raw outputs и generation ledger хранить только в его provenance/source boundary.
- [ ] [2-3ч] Скомпилировать architecture shell и проверить dimensions/openings/clearance до decoration.
- [ ] [2-3ч] Создать/generate window/door/frame modules и проверить construction details.
- [ ] [2-3ч] Создать/generate trims, acoustic system и built-ins и проверить room-DNA consistency.
- [ ] [2-3ч] Создать coherent concept images для major furniture/fixtures с одним room DNA.
- [ ] [2-3ч] Сгенерировать conference-table family, выполнить permitted cleanup и записать attempts/minutes.
- [ ] [2-3ч] Сгенерировать task-chair family, выполнить permitted cleanup и записать attempts/minutes.
- [ ] [2-3ч] Сгенерировать pendant-luminaire family, выполнить permitted cleanup и записать attempts/minutes.
- [ ] [2-3ч] Сгенерировать credenza/storage family, выполнить permitted cleanup и записать attempts/minutes.
- [ ] [2-3ч] Сгенерировать conference AV family, выполнить permitted cleanup и записать attempts/minutes.
- [ ] [2-3ч] Сгенерировать laptop/stationery family, выполнить permitted cleanup и записать attempts/minutes.
- [ ] [2-3ч] Сгенерировать planter/container family, выполнить permitted cleanup и записать attempts/minutes.
- [ ] [2-3ч] Сгенерировать acoustic-module family, выполнить permitted cleanup и записать attempts/minutes.
- [ ] [2-3ч] Сгенерировать power/cable-management family, выполнить permitted cleanup и записать attempts/minutes.
- [ ] [2-3ч] Создать material recipes, lighting plan и exterior treatment без копирования Track A final choices.
- [ ] [2-3ч] Собрать room, проверить style consistency и устранить только technical composition defects через specification/generation iteration.
- [ ] [1-2ч] Получить pre-freeze human rights sign-off accepted Track B meshes, textures и concept-derived outputs, включая recognizable brand/trade-dress similarity и повторную проверку model/provider terms.
- [ ] [1-2ч] Заморозить art version B до cross-track review.
- [ ] [1ч] Выполнить Track B GPU teardown instances, volumes, snapshots, temporary buckets и credentials; сохранить billing/deletion evidence.

### Этап 5. Общий runtime/optimization pass

- [ ] [1-2ч на track] Применить scale/orientation/pivot normalization и удалить helper geometry.
- [ ] [2-3ч на track] Выполнить measured dedup/prune/retopology/material consolidation.
- [ ] [2-3ч на track] Подготовить texture compression/atlas/KTX2 strategy и проверить PBR color spaces.
- [ ] [1-2ч на track] Добавить main spawn, восемь seats и required media surfaces, совпадающие с visible geometry.
- [ ] [1-2ч на track] Подготовить scene manifest, preview и complete `LICENSES.md` в соответствующем single-scene repository.
- [ ] [2-3ч на track] Запустить Khronos validator, glTF Transform inspect, assets validator и pinned platform validator.
- [ ] [2-3ч на track] Загрузить bundle локально через стандартный runtime path и снять `sceneDebug`.
- [ ] [1-2ч на track] Проверить four review viewpoints и отсутствие giant bounds/dark first frame/missing assets.

Условие перехода: оба frozen tracks проходят hard art-comparison profile и не требуют scene-specific runtime patch.

### Этап 6. Публикация и blind review

- [ ] [1-2ч] Собрать каждый immutable review release в отдельной final scene branch/PR; cross-track aggregate branch/PR запрещён.
- [ ] [1ч] Проверить immutable manifest, source reproduction, checksums и absence of private/unlicensed inputs.
- [ ] [1-2ч] Получить pre-publication signed rights verdict: complete provenance, output similarity/trademark review и неизменность применимых model/provider terms. Verdict является обязательным release-review input.
- [ ] [1ч на track] Commit/push, открыть отдельный scene PR и дождаться независимого CI.
- [ ] [1ч] Merge каждый scene PR только при green CI; затем commit experiment `candidate-lock.json` с двумя exact merge SHA, checksums и full-SHA CDN URLs.
- [ ] [1ч] Создать/обновить две staging review rooms без product catalog activation.
- [ ] [1-2ч] Проверить exact published bytes и desktop/mobile `sceneDebug` для обеих rooms.
- [ ] [1ч] После freeze review coordinator случайно назначает `Alpha`/`Beta`, применяет labels только к staging room, API room manifest и HUD и сохраняет закрытый mapping record. Immutable scene-bundle IDs и `scene.json.label` заранее нейтральны и после publication не меняются.
- [ ] [1-2ч] Зафиксировать оба scene-repository SHA, experiment/platform SHA, semantic camera transforms, FOV, viewport, DPR, exposure, cache mode и снять одинаковые screenshots/walkthroughs.
- [ ] [1-2ч] Получить независимые scorecards минимум от трёх non-author reviewers в random order либо явно маркировать single-reviewer qualitative mode.
- [ ] [1ч] Проверить заполненность scorecards и применить tie rule до раскрытия mapping.
- [ ] [1ч] Составить anonymous art score summary и принять решение о shipping comparison, не раскрывая mapping reviewers.
- [ ] [1ч] Если experiment заканчивается на `AB_ART_COMPLETE`, раскрыть mapping и дополнить final art report production time, yield, cleanup и runtime metrics. Если выбран shipping comparison, mapping оставить закрытым.

### Этап 7. Shipping comparison и follow-up

- [ ] [1ч] Зафиксировать `AB_ART_COMPLETE` verdict: visual winner/tie, hard-gate failures и границы допустимого вывода.
- [ ] [1-2ч] Решить, нужен ли production-pipeline comparison. Если нет, завершить art experiment без production claim.
- [ ] [2-3ч] Составить одинаковый measured optimization plan и equal active-time cap для Track A/B под combined mobile-lite/XR limits.
- [ ] [2-3ч] Выполнить Track A geometry/object/mesh optimization slice.
- [ ] [2-3ч] Выполнить Track A material/texture/bundle optimization slice.
- [ ] [2-3ч] Выполнить Track B geometry/object/mesh optimization slice.
- [ ] [2-3ч] Выполнить Track B material/texture/bundle optimization slice.
- [ ] [2-3ч на track] Повторить static/runtime validation и measured visual regression review.
- [ ] [1-2ч] Опубликовать два immutable shipping candidates через два независимых scene PR/CI paths и обновить experiment lock отдельным commit.
- [ ] [2-3ч] Выполнить final full local e2e на неизменённой final platform/experiment/two-scene combination.
- [ ] [2-3ч] Выполнить staging suite и key public room checks на exact platform, experiment и двух scene-repository SHA.
- [ ] [1-2ч на device/track] Проверить physical Android для A и B.
- [ ] [1-2ч на device/track] Проверить physical iOS для A и B.
- [ ] [1-2ч на device/track] Проверить Meta Quest для A и B.
- [ ] [1-2ч] Повторить blind shipping scorecard и подготовить shipping comparison report без предварительного назначения terminal outcome.
- [ ] [1ч] После сдачи shipping scorecards раскрыть mapping и дополнить report track-specific time/yield/cleanup/runtime evidence.
- [ ] [1ч] Записать `AB_SHIPPING_COMPLETE` или `AB_SHIPPING_STOP` pipeline verdict. Meeting-room evidence не изменяет FEAT-032 activation до готовности personal/presentation.
- [ ] [1-2ч] Если нужен hybrid C, создать отдельный re-plan с точным composition, rights, budget и QA scope; не собирать C внутри исходного A/B.
- [ ] [1-2ч] Если art direction пойдёт в FEAT-032, создать отдельный 4-seat adaptation plan/candidate без изменения review-only 8-seat releases.

### Будущая productization Scene Factory

Stable CLI, generic component registry, content-addressed generation cache и GPU job runner не входят в этот план. Dedicated pilot repository не считается productized service или reusable platform. Отдельный productization plan допустим только после повторного применения pilot approach минимум ко второй room type и должен доказать:

- Track B или measured hybrid реально использованы в двух room types;
- минимум 50% generated component families приняты;
- median cleanup accepted asset не больше 45 минут;
- deterministic downstream build работает от content-addressed accepted sources;
- measured recurring savings превышают поддержку GPU/tooling;
- rights/storage/retention process выдержал два release cycles.

## Evaluation scorecard

### Hard gates

- Rights/provenance complete.
- No private or restricted inputs.
- Scene Bundle/GLB validators green.
- `sceneBundleState=loaded`, `sceneDebug.state=loaded`, `sceneDebug.failureReason=null` и `sceneDebug.missingAssets=[]`.
- First view readable; dark ratio/luminance within requirements.
- No giant bounds, invalid spawn, blocked walkways или anchor/visible-seat mismatch.
- Art-comparison performance hard limits not exceeded.

### Visual score, 100 points

| Категория | Вес |
|---|---:|
| Whole-room coherence и ощущение реального места | 25 |
| Architecture: walls, ceiling, openings, trims, proportions | 20 |
| Materials, lighting и exterior integration | 20 |
| Furniture construction и detail quality | 15 |
| Functional realism и lived-in detail | 10 |
| VR scale, first-person readability и navigation cues | 10 |

Каждый reviewer ставит каждой категории score `1-5`:

- `1`: schematic/broken, назначение или конструкция неубедительны;
- `2`: room читается, но крупные stylistic, architectural или material defects очевидны;
- `3`: убедительно в первом кадре, но close-range review показывает заметные несогласованности;
- `4`: coherent room, minor defects не разрушают VR presence;
- `5`: production-quality в first-person и close-range views без существенных visual exceptions.

Weighted result нормализуется к 100 points. Reviewer обязан добавить одну evidence note для score `1-2` и одну strongest-quality note для score `4-5`. Разница меньше 5 points считается visual tie.

Итог track равен median нормализованных reviewer totals. Отчёт также публикует individual totals, category medians и spread. Major categories: whole-room coherence, architecture, materials/lighting и furniture construction. При single-reviewer qualitative mode numeric score сохраняется только как личная оценка и не поддерживает общий pipeline-superiority claim.

### Production report, отдельно от visual score

- One-time setup hours.
- Recurring room-production hours.
- Search/generation attempts.
- AI acceptance yield.
- Median и maximum cleanup minutes.
- Bundle size, runtime triangles/objects/meshes/materials/textures.
- Cold load и screenshot diagnostics.
- Number of manual artistic exceptions; для Track B target равен zero.
- Downstream reproducibility result от exact accepted source hashes; stochastic regeneration report хранится отдельно.

Рекомендуемый AI result threshold:

- все hard gates пройдены;
- median Track B visual score не ниже 85% Track A и одновременно не ниже `70/100`;
- не менее 6 из 9 planned component families приняты;
- accepted asset median cleanup не более 45 минут;
- recurring production time имеет реалистичный путь стать ниже curated/manual pipeline на следующей комнате.

Победа Track B в отдельных major categories является supporting evidence, а не заменой overall threshold.

Порог не гарантирует выбор B. Высокий visual score при неприемлемых rights, cost, cleanup или runtime metrics означает `stop` либо limited hybrid use.

## Тест-план

### Scene-lab unit и contract checks

- [ ] Valid scene specification и ledger проходят validator.
- [ ] Missing/unknown license блокирует publishable status.
- [ ] Non-finite/negative dimensions и invalid openings отклоняются.
- [ ] Unknown material/component/profile IDs отклоняются.
- [ ] Spawn/seat/surface вне room bounds отклоняются.
- [ ] Seat overlap, invalid yaw/radius/height и anchor-to-visible-chair mismatch отклоняются.
- [ ] Spawn без wall margin, open radius или `2.0 m` head clearance отклоняется.
- [ ] Manifest/runtime bounds ratio больше `3x`, extreme transforms и oversized background geometry отклоняются.
- [ ] Unsupported required glTF extensions отклоняются; missing/absolute external textures являются hard failure.
- [ ] Texture dimensions, maximum size, base-color sRGB и normal/roughness/metalness linear usage проверяются.
- [ ] AI record без model/license/prompt/seed/input IDs отклоняется.
- [ ] Rejected generation не может попасть в release manifest.
- [ ] Published artifact checksum обязан совпадать с ledger.

### DCC и asset checks

- [ ] Pinned Blender build/export command воспроизводим.
- [ ] Khronos glTF Validator: zero errors.
- [ ] glTF Transform inspect сохраняется в metrics report.
- [ ] В каждом scene repository собственные `pnpm manifest:check`, `pnpm validate`, `pnpm inspect` проходят независимо.
- [ ] Pinned platform template/scene validator проходит для обоих tracks.
- [ ] Accepted raw AI outputs закреплены checksum. Два downstream exports из exact source inputs и pinned environment byte-identical.

### Local runtime

- [ ] Оба bundles загружаются через standard Scene Bundle path без runtime patches.
- [ ] `sceneBundleState=loaded`, `sceneDebug.state=loaded`, `sceneDebug.failureReason=null`, `sceneDebug.missingAssets=[]`.
- [ ] Runtime bounds finite и соответствуют manifest bounds.
- [ ] Runtime/manifest bounds ratio, spawn margin/open radius/head clearance и visual thresholds из `docs/scene-technical-requirements.md` проходят численно.
- [ ] Entry/participant/presenter/overview views human-readable.
- [ ] Все восемь seats/surfaces совпадают с visible furniture и проходят static overlap/yaw/radius/clearance checks.
- [ ] Desktop и mobile viewport не показывают black/empty/inside-geometry first frame.
- [ ] `debug-main` и `whiteboard-wall` существуют, имеют валидные dimensions/transforms и совпадают с visible surfaces.
- [ ] Runtime последовательно выполняет claim/release каждого из восьми seats; seated movement lock и release/teleport state не регрессируют.
- [ ] Synthetic occupancy размещает восемь avatar fixtures одновременно без overlap, table clipping или state collision.
- [ ] Multi-client scenario проверяет 2-4 participant presence/spatial audio, screen share на `debug-main`, whiteboard content на `whiteboard-wall`, visibility/aspect и seat-state isolation.
- [ ] Один раз после final implementation выполнить полный `pnpm test:e2e` на неизменённом final tree.

### Published staging

- [ ] Manifest/GLB bytes каждого кандидата загружаются с full SHA его scene repository и совпадают с experiment lock/checksums.
- [ ] Alpha/Beta rooms используют exact immutable URLs.
- [ ] Desktop и mobile `sceneDebug` сохранены в experiment report вместе с exact scene-repository SHA каждого кандидата и platform SHA.
- [ ] `pnpm test:e2e:staging` проходит на deployed platform commit; pre-existing platform/test mismatch документируется отдельно и не маскируется как scene pass.
- [ ] Hall, BlueOffice и ArtGallery baseline rooms продолжают достигать `loaded`, если затронут runtime/loader.
- [ ] Для `AB_SHIPPING_COMPLETE` оба tracks проходят physical Android, iOS и Meta Quest checks; будущий hybrid имеет собственный device gate.

Physical-device acceptance для каждой пары device/track наследует FEAT-032 protocol:

- три cold-load runs без warm HTTP cache на согласованном Wi-Fi/network profile;
- каждый run не более 20 секунд до `sceneDebug.state=loaded`;
- не менее 10 минут navigation/surface stability;
- exact device model, OS/browser/GPU, date, platform SHA и соответствующий scene-repository SHA/checksums;
- `sceneDebug.missingAssets.length=0`, отсутствие crash/reload/OOM, корректные spawn и key flows;
- для meeting scenario 2-4 automated companion clients и минимум два real endpoints для spatial-audio audibility;
- на Quest: refresh rate, median/p95 frame time, dropped/reprojected frames и stalls больше 100 ms;
- Quest thresholds: median в device frame budget, p95 не больше `2x` budget, stalls меньше `0.1%`, dropped/reprojected frames меньше `5%`.

Если pilot обнаруживает общий platform/runtime gap и меняет executable platform code, дополнительно обязательны affected package build/test, final full local e2e, commit/push, normal CI/CD deploy и staging gate exact platform commit. Scene-only publication проверяется против одинакового pinned platform-validator SHA и exact published SHA каждого scene repository.

## Затронутые repository areas

### Experiment / Scene Factory repository

- `experiment/warm-modern-meeting-room/` для common brief, style bible, locks и reports;
- `schemas/` для pilot spec/ledger contracts;
- `compiler/` и `scripts/` для Blender compile/reporting после green feasibility gate;
- experiment CI для schema, report и cross-repo lock validation;
- scene source files, GLB и previews здесь запрещены.

### Candidate 01 repository

- `source/` и `provenance/` только первой сцены;
- `assets/scenes/<candidate-01-scene-id>/<version>/`;
- собственные `manifest.json`, `platform-validator.lock`, validation/publication CI;
- второй scene ID и cross-track Scene Factory code запрещены automated boundary check.

### Candidate 02 repository

- `source/` и `provenance/` только второй сцены;
- `assets/scenes/<candidate-02-scene-id>/<version>/`;
- собственные `manifest.json`, `platform-validator.lock`, validation/publication CI;
- второй scene ID и cross-track Scene Factory code запрещены automated boundary check.

### Existing multi-scene repository

`vrata-labs/scene-assets` в pilot не изменяется. Его historical releases могут использоваться только как compatibility/tooling reference без копирования scene content.

Platform repository должен изменяться только если обнаружен общий runtime/validator gap. Любая такая правка оформляется отдельным scoped task/PR и обязана соблюдать runtime ownership, full local e2e, normal CI/CD deploy и staging gate. A/B не должен добавлять scene-specific behavior в `apps/runtime-web/src/main.ts`.

## Риски и митигации

| Риск | Митигация |
|---|---|
| Снова получится blockout из примитивов | Art gate до runtime integration; architecture detail checklist; запрет считать compiler output финальным без materials/lighting/detail pass |
| AI генерирует красивые renders, но плохую 3D geometry | Три-probe feasibility gate; close-range Blender/runtime review; cleanup cap; honest stop verdict |
| AI furniture не согласуется с room architecture | Единый style bible, room DNA, component concept sheets и scene specification |
| Whole-room concept невозможно превратить в редактируемую сцену | Декомпозиция concept в plan/elevations/material zones/components; deterministic architecture compiler |
| Generated texture не является корректным PBR | Cleared PBR substrate library, validated recipes, no fake normal/roughness maps без review |
| Внешний вид за окном ломает parallax/bounds | Ограниченный 2.5D/low-detail exterior или cleared HDRI; исключение giant background geometry из room bounds |
| Track B получает больше времени и нечестно выигрывает | Отдельно учитывать setup; одинаковый recurring production cap; логировать attempts/cleanup |
| Track B вручную перемоделирован до приемлемого вида | Разрешить только technical cleanup; artistic remodel считается rejected output |
| Marketplace/license позволяет render, но не extractable GLB | CC0-first policy и explicit redistribution field; uncertain asset blocked |
| Open-source code/model license ошибочно принимается за rights на outputs | Отдельный human-owned AI rights gate для code, weights, dependencies, provider, inputs, outputs и territories |
| AI output похож на известный branded product | Generic prompts, original/CC0 inputs, visual similarity review и rejection branded results |
| GPU недоступен или расходы растут | Disposable worker, hard cost cap, teardown после spike, не строить service до proof |
| 6 GB local GPU недостаточна | Не пытаться деградировать experiment слабой local model; использовать 16+ GB disposable compute |
| High-quality winner не помещается в mobile/XR limits | Отдельный measured optimization pass; activation blocked; quality-tier runtime task только по фактам |
| A/B assets случайно активируют product template | Новые review-only IDs/rooms; никаких registry/current-version изменений в pilot PR |
| Private benchmark contaminates room design | Не показывать Sense/private scenes авторам или моделям до A/B freeze; после freeze использовать только для broad quality-gap review |
| Raw attempts раздувают Git или раскрывают restricted inputs | Public/private storage boundary, quota, retention/deletion policy и хранение ledger hashes вместо rejected binaries |
| Stochastic model нельзя воспроизвести | Accepted raw output становится immutable source; deterministic downstream export проверяется отдельно |
| Cross-repo версии расходятся | Experiment lock фиксирует два scene SHA, checksums и единый platform-validator SHA; staging читает только exact lock |
| В scene repository появляется вторая сцена или factory code | Независимый boundary validator и required CI check отклоняют второй scene root и запрещённые top-level paths |

## Rollback и cleanup

- A/B использует новые immutable review IDs; существующие room/product bindings не переписываются.
- Перед mutation сохранить room snapshots. Для staging rollback вернуть review room URL/name/snapshot на сохранённое состояние или удалить только временную review room.
- Published failed experiment release не изменяется и не удаляется из истории своего scene repository; он помечается rejected/obsolete metadata в следующем commit этого же repository и в новом experiment lock/report.
- Не прошедшие rights check inputs/outputs не публикуются и остаются вне public repository.
- Обнаруженная после публикации rights/security проблема запускает quarantine/takedown: немедленно unbind review rooms, убрать ссылки/current metadata, остановить новые downloads через управляемый origin, обратиться к Git/CDN host и выполнить history remediation по отдельному approved procedure. Immutable naming не оправдывает продолжение публичной раздачи спорного asset.
- Disposable GPU instances, volumes, snapshots, buckets и API credentials удаляются или отзываются после каждого spike/full-track generation phase; teardown и прекращение billing записываются в report.
- Platform rollback не требуется, если runtime code не менялся. Если менялся, применяется обычный immutable SHA rollback и staging smoke из project contract.
- Wave 2/3 state и production template catalog остаются нетронутыми до отдельного activation decision.

## Оценка

Последовательная работа одного 3D-разработчика:

| Этап | Оценка |
|---|---:|
| Definition of Ready, brief, references, style bible, scorecard | 2-4 дня |
| AI rights и feasibility spike | 3-6 дней |
| Pilot-specific scene-lab/compiler после green spike | 3-5 дней |
| Track A complete art room | 4-7 дней |
| Track B complete art room | 6-10 дней |
| Art-profile optimization, publication и blind review | 3-5 дней |
| Task-sum lower bound до `AB_ART_COMPLETE` | 21-37 рабочих дней |
| Резерв 30-50% на visual/export/performance iterations | 6-19 дней |
| Forecast до `AB_ART_COMPLETE` | 27-56 рабочих дней |
| Optional equal shipping pass обоих tracks | ещё 5-10 дней плюс device waits |

Это исследовательская оценка, а не обещание календарной даты. После feasibility spike forecast и equal active-time cap пересчитываются по измеренным rates. Alternative model, hybrid C, rights/provider waits и physical-device waits оцениваются отдельными сценариями. Параллельный forecast допустим только при двух назначенных исполнителях и не должен скрывать one-time Scene Factory setup.

## Порядок остановки и продолжения

Работа останавливается на ближайшем gate, если:

- style bible не утверждён;
- AI probe gate не пройден;
- rights/provenance не доказаны;
- A или B не достигают минимального visual completeness;
- required runtime hard gate не проходит;
- compute cost превышает утверждённый cap;
- visual quality требует нарушения mobile/XR contract без отдельного product decision.

Outcome выбирается по стадии failure:

- failure AI rights/compute/probe gate до full tracks: `FEASIBILITY_STOP`;
- failure/cap exhaustion после green feasibility, но до двух сопоставимых art bundles: `AB_ART_STOP`;
- failure одного или обоих tracks на equal shipping/device pass: `AB_SHIPPING_STOP`;
- неготовый Definition of Ready или неутверждённый style bible означает `blocked`, а не failed experiment; работа возобновляется после закрытия зависимости.

После каждого gate в этот план добавляются дата, commit/artifact links, verdict и следующие измеримые задачи. Чекбоксы отмечаются только после сохранения evidence, а не по факту начала работы.
