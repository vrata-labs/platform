# ADR: agentic deterministic scene authoring

Дата: 2026-08-29

Статус: принято как рабочий подход для новых project-authored Vrata scenes

## Контекст

Vrata нужны разные оригинальные сцены, а не один вручную поддерживаемый demo bundle. Curated asset pipeline требует длительного поиска, проверки прав на redistribution внутри скачиваемого GLB и выравнивания разнородных моделей. Генерация готовых 3D assets отдельными image-to-3D моделями добавляет model/provider rights, stochastic source и cleanup cost.

Warm Modern Meeting Room Candidate 01 показал третий практический путь. Агент спроектировал room, создал scene-specific Blender/Python art pass, итеративно проверил semantic review views, собрал self-contained GLB и прошёл human visual и rights gates при минимальном участии пользователя. Финальная сцена не использует external meshes, textures, HDRI, private sources или generative 3D model outputs.

Это не завершённый controlled A/B и не доказательство превосходства одного исходного track. Полученный подход называется **agentic deterministic scene authoring**.

## Решение

Для новых project-authored Vrata scenes по умолчанию используется следующий контур:

```text
human brief
  -> model-agnostic LLM planner / art director
  -> canonical scene contract
  -> scene-specific Blender authoring pass
  -> accepted Blender source
  -> deterministic export and review scripts
  -> static validators and semantic review views
  -> human visual acceptance
  -> human rights approval
  -> immutable scene bundle release
  -> runtime and staging verification
```

LLM отвечает за планирование, scene-specific artistic decisions, tool use и поиск визуальных дефектов. Blender является DCC, renderer и детерминированным build worker. Scene Bundle v1, runtime contracts и validators остаются независимыми от способа авторинга.

OpenCode является текущим agent orchestrator, но не частью долговременного scene contract. Другой orchestrator или прямой OpenAI API допустимы, если сохраняются те же source, provenance, validation и acceptance boundaries.

## Граница воспроизводимости

LLM-authoring не считается byte-deterministic. Повторный запрос к той же или новой model revision может дать другой план и другой код.

Воспроизводимость начинается после human acceptance. Source of truth принятой сцены включает:

- canonical brief и scene contract;
- scene-specific authoring source;
- accepted Blend с packed project-authored textures;
- pinned Blender version, build hash и exporter revision;
- deterministic export script;
- semantic review render script и review views;
- provenance ledgers и отдельный human rights verdict;
- release manifest, GLB, preview, checksums и measured stats.

Accepted source нельзя оставлять только в чате, `/tmp`, локальном cache или model transcript. Он хранится в scene package до публикации release.

Минимальный reproducibility gate для каждого release:

- два clean exports из одного accepted source на одном pinned Blender binary дают byte-identical GLB;
- Khronos glTF Validator не сообщает errors или warnings;
- glTF Transform inspect и scene metrics сохранены или воспроизводимы;
- cross-host geometry, materials, textures, bounds и manifest semantics совпадают;
- preview bytes не сравниваются между разными GPU/driver stacks, вместо этого применяются semantic view, luminance и perceptual checks.

## Граница координат

Canonical scene contract может использовать semantic authoring coordinates, но release manifest обязан содержать координаты runtime asset после DCC/export transforms. Для принятого Blender Y-up path semantic `(x, y, z)` преобразуется в Blender `(x, z, y)`, а GLB/runtime получает `(x, y, -z)`.

Один явный coordinate adapter должен применяться к spawn points, seat anchors, media surfaces и другим runtime anchors. Release validation сравнивает эти поля с canonical scene contract через тот же adapter. Копирование authoring coordinates напрямую в `scene.json` запрещено даже при корректном GLB.

Runtime staging gate проверяет фактическую local pose и world transforms anchors. При `?debug=1` обязательно добавлять `&scenefit=0`, иначе debug auto-fit заменяет scene spawn и даёт ложный результат проверки.

## Логический scene package

Контракт не требует отдельного repository для каждой из будущих сотен сцен. Изоляция задаётся логическим package boundary:

```text
<scene-id>/
  brief-and-contract/
  source/
  provenance/
  review-evidence/
  releases/<version>/
```

Физически package может находиться в отдельном scene repository, multi-scene catalog repository или content service. Обязательны:

- stable scene ID;
- отсутствие неявных cross-scene source dependencies;
- раздельные accepted source и immutable releases;
- per-release provenance и checksums;
- full-SHA or content-addressed publication;
- запрет scene-specific runtime patches.

Отдельные repositories остаются правильным выбором для blind experiments, customer/private ownership boundaries или независимого release lifecycle. Repository topology для массового catalog не фиксируется этим ADR и должна выбираться отдельно по operational cost.

## Масштабирование на новые сцены

Следующие personal и presentation scenes должны повторить весь контур, а не копировать meeting-room composition. Для каждой сцены измеряются:

- число authoring и visual correction iterations;
- wall-clock и active human time;
- число human interventions до acceptance;
- доля reusable и scene-specific operations;
- GLB size, triangles, nodes, materials, textures и load time;
- reproducibility, rights и runtime gate results.

Reusable operation переносится в общий authoring core только после повторения минимум в двух разных room types. До этого scene-specific Python остаётся внутри scene package. Это защищает от premature generic DSL и сохраняет свободу художественных решений.

## Будущий сервис

Productized authoring service отложен до successful end-to-end delivery meeting, personal и presentation room types.

Первая допустимая service iteration является internal asynchronous job system:

- OpenAI или другой LLM через model adapter;
- persisted job state и bounded retry budget;
- ephemeral non-root Blender workers;
- no-network execution для generated code;
- CPU/GPU, memory, disk и timeout quotas;
- immutable artifact storage;
- validators как hard gates;
- human visual и rights approvals до publication.

Произвольный model-authored Python нельзя запускать в публичном multi-tenant worker без sandbox. После накопления повторяемых операций LLM должен преимущественно выдавать typed scene spec и allowlisted tool calls; Python остаётся internal escape hatch.

Self-host runtime Vrata не должен зависеть от authoring SaaS. Пользователь может загрузить уже собранный Scene Bundle без доступа к LLM или Blender service.

## Альтернативы

### Curated external assets как default

Не выбрано как default. Остаётся допустимым для конкретной сцены при доказанных redistribution rights. Основные недостатки: search cost, license variance, inconsistent style и cleanup.

### Image-to-3D generation как обязательное ядро

Отложено. Может использоваться как optional tool только после отдельного rights, quality и cleanup gate. Accepted raw output в таком случае становится immutable source и получает полный generation ledger.

### Одна большая procedural generator script на каждую сцену

Не выбрано как долговременная архитектура. Такой подход уже работает для отдельных scenes, но без accepted-source contract, orchestration boundary и extraction rule он плохо масштабируется и провоцирует копирование scene-specific code.

### Сразу построить универсальный Scene Factory service

Отклонено как premature productization. Одна успешная новая сцена доказывает feasibility, но не generic API и не экономику сервиса.

## Последствия

Положительные:

- accepted release воспроизводится без повторного вызова LLM;
- art direction не ограничен каталогом готовых assets;
- rights chain проще для project-authored geometry и textures;
- authoring orchestrator можно заменить без изменения scene/runtime contracts;
- общие операции выделяются по фактам нескольких сцен;
- подход совместим с будущим internal service и self-host platform.

Отрицательные:

- качество новых room types ещё требует повторного доказательства;
- scene-specific scripts первое время неизбежны;
- visual render bytes зависят от host GPU/driver;
- generated Python требует строгой sandbox policy;
- human visual и rights gates остаются обязательными.

## Evidence

Первый accepted specimen:

- repository: `vrata-labs/warm-modern-meeting-room-candidate-01`;
- scene ID: `warm-modern-meeting-room-candidate-01`;
- active release: `0.1.1`; immutable `0.1.0` сохранён как superseded после обнаружения authoring/runtime `z` mismatch;
- release commit: `e9891721220bbcda8099d8bbad52e08b3b59427c`;
- publication evidence merge: `863ef6ad4200c5e78002363c502ad98445bd62b7`;
- release manifest SHA-256: `bdded23cb2b0d7686459d42d24e135920200f7c7f8a66cbcec8c6f57f9f79eb9`;
- accepted Blender source SHA-256: `fbddeac0c0fc8e65f3beb736917574f9515116fdb4ef42e4a9cdaa7d10f12b16`;
- deterministic two-run GLB SHA-256: `bc987fd7c5931eeccc23cf260011364299c636091e9b82932af2df30db7d95f5`;
- 15,840 triangles, 146 nodes/meshes, 16 materials, 9 embedded textures;
- Khronos validation: zero errors and zero warnings;
- human visual acceptance and separate human rights approval: 2026-08-29;
- release PR/CI: `#9`, runs `33219493841` and `33219542528`;
- publication evidence PR/CI: `#10`, runs `33220162663` and `33220217676`;
- staging room: `https://158.160.10.234.sslip.io/rooms/agentic-scene-authoring-review?debug=1&scenefit=0`;
- staging report: `rpt_ad6e7ec9-5dfe-4f9c-a229-6fc57e08f417`, `sceneDebug.state=loaded`, corrected main spawn `(2.6, 0, 1.64)`, two corrected media surfaces, zero missing assets and zero console errors.
