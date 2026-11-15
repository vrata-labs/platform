# T17: карта приёмки

Runtime candidate: `4d5ca28883cffbf08a82112f33a25fca18431164`, опубликован в origin в PR #157 после merge S3-поставки #159. Включает изменения runtime D-103–D-111; `9d7b2db` и main `51668aa26f64dc6d56045ac9bff6a14b1038f129` — исторические версии, не текущий кандидат приёмки. Проверенный self-host harness SHA: `efa4b61163191cf13b0b590b5dbc52d398d24c66` (D-098, D-112–D-118). Изменение только отчёта не означает новую сборку runtime; исполняемое изменение продукта требует нового runtime SHA и повторных относящихся проверок.

План: внешний `2026-09-25-working-meeting-and-room-plugins.md`, §3, T17, §8. Контракт: [JSON](2026-11-05-t17-product-acceptance.json). Основания: [пакет](../context/2026-11-05-t17-product-acceptance.json). Решения: [журнал](../reviews/2026-11-05-t17-acceptance-decisions.md).

Ни один результат T16 и исключение D-097 не закрывают T17. Статус всей задачи — **NOT_READY** до всех обязательных подтверждений. Fresh self-host — отдельный автоматизируемый подпункт, не встреча четырёх людей.

| WM | Автоматические основания/проверка на final SHA | Обязательное дополнение T17 |
|---|---|---|
| 01 | public-demo/document-meeting, реальные PDF bytes/страницы/reload | Собственный PDF через picker; люди видят 1→2→3, late join/reload |
| 02 | public-demo authority и presenter-meeting; старые REST/WS denials | Живое назначение/отзыв Presenter и Stop screen у людей |
| 03 | screen-share/presenter transport tests | Выбор настоящего окна/вкладки desktop, движущееся изображение desktop+Android, cancel/Stop/view-only |
| 04 | meeting-tools/document-meeting, notes persistence/guest denial | Независимая доска, Android touch, Notes и экспорт решений |
| 05 | fresh self-host normal Host UI, Guest/cross-room denial; plugin-author security tests | Права не наследуются от admin setup |
| 06 | fresh self-host SDK download и внешний standalone CLI, две версии и второе имя пакета, image/start continuity | Без rebuild/restart при публикации артефакта |
| 07 | sandbox/resource/authority suite final local+CI | Встреча продолжает работать; автоматические attacks не заменяются одной status-пробой |
| 08 | fresh self-host UI update/approval/CAS/restart/disable/unbind/delete; pending-disable suite | Прежние generation и delayed effects запрещены; full suite обязателен |
| 09 | auto-seat final local+CI: 4 clients и 8+1; stage по своему coverage | Четыре человека в настоящей сцене с обычным рендером, комфорт и ручной выход |
| 10 | plugin-less/disabled/fallback/no Worker/WASM suites, соседняя комната self-host | Обычный вход/ручная посадка, нет изменений template snapshots |
| 11 | synthetic transport только как автоматическое основание | Четыре реальных человека, desktop↔физический Android, два настоящих микрофона и слышимость |
| 12 | final-local, CI/Docker, exact-SHA G/X, self-host и cleanup | Device report, D01–D08, Quest по применимости; любой отказ — REWORK_REQUIRED |

## Исходное состояние 2026-11-05

- Исторический отдельный clone origin получен на `51668aa`; его prepared env/state сохранены и не используются для `9d7b2db`. Для нового кандидата выделен отдельный delivery root `/tmp/opencode/vrata-t17-final-9d7b2db`, без source clone и prepared state до публикации SHA.
- Штатные инструкции: `docs/self-hosting.md`, `docs/demo/README.md`, `docs/plugin-storage-lifecycle.md`; Compose selfhost+demo-local. Существующий `storage-lifecycle.spec.ts` использует fixture и не подменяет fresh clone.
- Linux Docker socket отсутствует; доступен Windows Docker Engine 29.4.1 и Compose 5.1.3 через named pipe. Перезапуск Docker/WSL/сети не требуется.
- Package test на `51668aa` завершился exit 1 без таймаута: отсутствовали pinned rollback object `81c14b6ac8dbc537892f7b1f342ca8f718fdf0a6` и `VRATA_PLUGIN_ROLLBACK_STORAGE_MODULE`. Два API-теста остановились в `assertLocalPluginRollbackObject` до проверок совместимости (API: 1859 passed / 2 failed / 6 skipped; root tools после `&&` не запускались). Это отказ подготовки fixture, не доказанный дефект продукта и не произвольный таймаут. Источники: `rollback-fixture.test-helper.ts:14–18`, `rollback-compat.postgres.test.ts:27–54`, receipt `1793893065934247928-package-test-136b5e16.json` и `superseded-package-51668aa-analysis.private.json` в приватном пакете приёмки.
- Незавершённый full-local `51668aa` отменён после смены кандидата; terminal `t17-full-local-51668aa-80ca1f9e/terminal.json` имеет blocked, package failure сохранён. Отмена не является PASS; источник — `superseded-full-local-51668aa.json`. Local/CI/Docker/stage на `9d7b2db` и ручная встреча требуют отдельных подтверждений.

## Own marker: согласованный способ доказательства, D-103

Скрытие собственного маркера обязательно и не подменяется occupied. Вместо floor-only own PNG владелец критерия согласовал два совместных основания:

- Отдельный WebGL-переход видимого свободного маркера в current с пустой occupancy: PNG `component-before-current` и `component-current-hidden`, фактические входы и render snapshot в `component-current-proof`. Occupied проверяется отдельно, тоже после восстановления видимости.
- Обе реальные reference-комнаты: `room-own-seat-authority-proof` связывает собственный participantId/currentSeatId и клиентскую occupancy с новым авторитетным room_state на существующем WebSocket; seated root соответствует штатному lock и сохраняется после кадров. Один HTTP-успех, чужая occupancy или отсутствие маркера за пределами кадра недостаточны.

Новые component/current и room attachments ещё предстоит получить и проверить. Release должен показать тот же свободный маркер без перекрывающего аватара при неизменном observer pose/DPR/canvas. Ожидание новой received pose и playback/render settling не заменяет просмотра actual PNG и укладывается в прежние 15 секунд.

Исторические RF 4/4 и visual 5/5 не удаляются и не становятся качественным PASS. Предыдущий визуальный набор сохраняет REWORK_REQUIRED; это неполнота доказательств, а не установленный runtime/art дефект. Принятый самостоятельный browser PNG нового дизайна маркера с provenance остаётся отдельным открытым source gate, не отменённым D-103. Новые автоматические local/CI/Docker результаты перечислены ниже отдельно; визуальные F1/F7 и полный F6, Staging Extended и physical/device gates остаются открытыми. T17 NOT_READY.

## Запуск fresh self-host

Оснастка: `tools/t17-selfhost-acceptance.py`; отдельный Playwright config: `tests/selfhost/playwright.config.ts` (без webServer/fixture). Продукт собирается штатными Dockerfiles из `git archive` exact runtime SHA. Author helpers, включая транзитивный functional-diagnostics, сверяются побайтно с этим SHA; hashes самой оснастки записываются отдельно. Приватные env, state и логи — только в новом каталоге доставки вне репозитория.

```bash
DELIVERY="$(mktemp -d /tmp/opencode/t17-selfhost-4d5ca28-XXXXXXXX)"
python3 tools/t17-selfhost-acceptance.py preflight --delivery "$DELIVERY"
python3 tools/t17-selfhost-acceptance.py run --wait-lock --delivery "$DELIVERY"
```

Предусловия запуска: exact `4d5ca28` опубликован в origin; относящиеся local gates должны завершиться успешно. Полный fresh lifecycle уже прошёл: run `t17-1a558568d6e3`, `acceptance-proof.json`, S13/F8. Пример выше предназначен только для новой необходимой проверки, не для повторного использования завершённой попытки. Runner создаёт новый clone origin на этом SHA; старый clone, env, project и использованные claims/intents подставлять нельзя. После завершённой попытки нужен другой новый delivery, без продления прежних сроков. По умолчанию `preflight`/`run` берут `/tmp/opencode/vrata-t17-browser.lock` без ожидания; код 75 означает занятую очередь, не провал продукта. `run --wait-lock` сериализует self-host с full local; второй внешний flock не нужен. Код 0 означает успешную выбранную операцию, 1 — failed lifecycle, 2 — ошибку runner; preflight exit 0 не является lifecycle PASS. Runner собирает собственные образы из source, поднимает штатный self-host и сохраняет результат независимо от исхода, отдельно пытаясь очистить только свои ресурсы. Повтор завершённого сценария автоматически не выполняется; исходные отказы не затираются. Ручной cleanup: тот же delivery и операция `cleanup` без `--wait-lock`, после проверки приватного terminal record.

Исторические подготовительные проверки `51668aa`: pristine clone/dependencies, stock/isolated Compose model, свободные порты/пустой project, collection 1 test. Первоначальные ошибки типов без workspace resolution сохранены; последующий полный tsc с mappings прошёл. Исправления оснастки `d3ec1ee` прошли 16/16 регрессий, полный tsc, два реальных read-only Compose config с одинаковым результатом при обычном и конфликтующем inherited env и ревью APPROVE без открытых замечаний. Вердикт не распространяется на bootstrap fix `9d7b2db` и не является self-host PASS.

После смены target на `9d7b2db` выполнены 16/16 регрессий, Python syntax, полный harness tsc, JSON parse/проверка пакета оснований и diff check. Старый dependency mapping использован только для TYPECHECK: `git diff 51668aa..9d7b2db` по `apps`, `packages`, `tests/e2e` и dependency manifests пуст; clone остался pristine. Это не fresh clone `9d7b2db`, не проверка его сборки и не runtime lifecycle. На этом историческом срезе install/run/update/restart/disable/delete/storage audit/cleanup ещё предстояли; текущий результат на `4d5ca28` отражён в S13/F8.

## Подтверждённые результаты 2026-11-15

- Local, S12/F7: сборка, типы, модульные тесты и полный GPU e2e **271/271**, workers=1/retries=0/skips=0. Private-assets: **3 passed / 2 прежних optional skips**; пропущенные hall reconnect и author-specific visual views не объявляются проверенными. Приватные fixtures до/после совпали по хешам. Эти числа не закрывают визуальные требования выше.
- [CI 43702462375](https://github.com/vrata-labs/platform/actions/runs/43702462375), attempt 1: pull_request, core и шесть e2e shards фактически checkout `2d523747a6206f2a64b45aa1605c0f49e43b1784`. Его дерево и дерево runtime F равны `1461a58674f42e5d6317b9e32deaf689a53110e3`. Это проверка идентичного дерева synthetic PR merge, не commit F и не main. [Seat marker checks 43702462518](https://github.com/vrata-labs/platform/actions/runs/43702462518) успешны.
- [Docker Publish 43702698904](https://github.com/vrata-labs/platform/actions/runs/43702698904), attempt 1: workflow_dispatch feature-ветки, фактический checkout F. В `docker-publish-proof.json` сохранены immutable digests API, room-state и remote-browser, а также два проверенных переиспользованных storage-образа. Именно эти образы F развёрнуты на staging.
- Self-host, S13/F8: run `t17-1a558568d6e3`, завершён 2026-11-15T13:57:18.887727Z за 247.532 с; runtime F, harness `efa4b61`. Полный штатный source-build lifecycle прошёл: внешний SDK, UI install/update без rebuild/restart, API restart/обычный повторный вход, persistence, disable/unbind/delete, authority/no ghosts и сохранение соседней комнаты/SDK. expected=1/unexpected=0/skipped=0/flaky=0. Оба клиента GTX 1060/D3D12, 1280×720/DPR1, без fakeMedia. Аудит: 0 plugin rows/bindings/private objects; собственные ресурсы и короткий browser TMPDIR удалены, source чистый/harness неизменён.
- Self-host proof: `acceptance-proof.json`, SHA-256 `e9b7822ef7e39ef6f53eabd6063da860eb3d58d643353c8c60e32daa63174b9d`. Семь исходных отказов сохранены. Два автоматических браузера не заменяют четырёх людей и физические устройства.
- Staging, S14/F9: первый [bootstrap 43713022613](https://github.com/vrata-labs/platform/actions/runs/43713022613) отказал на TLS S3 до source upload/rollout. Исправление CA [PR #160](https://github.com/vrata-labs/platform/pull/160) слито в main как `36a02c6`.
- Main CI, S15/F10, D-119: PR #157 слит squash как `32c8198ed954876239f1b1dc4ffabecaef48e2bd`. [CI 43755563620](https://github.com/vrata-labs/platform/actions/runs/43755563620) и [Docker Publish 43755563608](https://github.com/vrata-labs/platform/actions/runs/43755563608), push, attempt 1, успешны; фактический checkout — этот коммит. Его пути apps, packages, infra, tests/e2e, lock-файл и playwright-конфиги побайтно равны F. Первая попытка CI 43752992980 на head ветки отказала на нестабильном `administrative-ownership.spec.ts:55`, повтор упавших заданий прошёл.
- Staging, S16/F11, D-120: [bootstrap 43755854604](https://github.com/vrata-labs/platform/actions/runs/43755854604) развернул F на новом хосте; сцены `ed0c972` получены из S3 по lock без Git сцен, откат не понадобился. Accepted record: imageSha F, assetSha `ed0c972`, runId 43755854604, mode ordinary; дайджесты работающих образов совпадают с Docker Publish 43702698904. [Template Catalog activate 43757059152](https://github.com/vrata-labs/platform/actions/runs/43757059152) на checkout F: полный staging-набор **56/56**, 13 сцен, Hall/BlueOffice/ArtGallery loaded. Браузер в трёх комнатах не обращается к selcloud.ru. Backup хоста восстановлен без Git сцен, 215/215 файлов совпали с локальной сборкой F; предыдущего релиза на новом хосте нет.
- Staging Extended, S17/F12: [43758947354](https://github.com/vrata-labs/platform/actions/runs/43758947354), обе попытки **5 passed / 1 failed**. Воспроизводимо падает `room-plugin-auto-seat-staging.spec.ts:22` (lastInstanceFailure=wasm_load_failed) на программной отрисовке; против того же стенда на GPU 3/3. Причина и варианты исправления — в [backlog](../backlog/2026-11-15-auto-seat-pending-sticky-wasm-retry.md). Аренда `751c3168` освобождена.

Причина Extended уточнена в D-121: после loaded первый тяжёлый кадр блокирует основной поток на 3,3–4,8 с. Он может перекрыть получение и компиляцию WASM либо обработку pending claim. Таймер истекает раньше завершения операции; в замеренном WASM-отказе сетевой ответ занял 0,27 с. Это реальный конфликт готовности и сроков, не просто ложное замечание теста. Измерения с GPU служат контролем причины, но не закрывают Extended. Временная оснастка удалена, дополнительная аренда `dc5ac1ae` освобождена.

Открыты исправление причины красного Staging Extended (published-staging), визуальная приёмка и реальная встреча WM-01…12 с Android/микрофонами/применимым Quest. Общий статус **NOT_READY**.
