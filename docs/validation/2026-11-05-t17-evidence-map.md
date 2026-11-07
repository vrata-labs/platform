# T17: карта приёмки

Runtime candidate: `9d7b2db4c60df1d39dd5769f6f4676addfb0f03c` с исправлением storage bootstrap (D-100), пока не опубликован в origin. Main `51668aa26f64dc6d56045ac9bff6a14b1038f129` (PR #156) — подтверждённый исторический baseline, не текущий кандидат приёмки. Docs/harness SHA записывается отдельно после фиксации оснастки (D-098). Изменение только отчёта не означает новую сборку runtime; исполняемое изменение продукта требует нового runtime SHA и повторных относящихся проверок.

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

Исторические RF 4/4 и visual 5/5 не удаляются и не становятся качественным PASS. Предыдущий визуальный набор сохраняет REWORK_REQUIRED; это неполнота доказательств, а не установленный runtime/art дефект. Принятый самостоятельный browser PNG нового дизайна маркера с provenance остаётся отдельным открытым source gate, не отменённым D-103. F1/F7, full F6, CI/Docker/stage и physical/device gates сохраняются; T17 NOT_READY.

## Запуск fresh self-host

Оснастка: `tools/t17-selfhost-acceptance.py`; отдельный Playwright config: `tests/selfhost/playwright.config.ts` (без webServer/fixture). Продукт собирается штатными Dockerfiles из `git archive` exact runtime SHA. Author helpers сверяются побайтно с этим SHA; hashes самой оснастки записываются отдельно. Приватные env, state и логи — только в каталоге доставки вне репозитория.

```bash
python3 tools/t17-selfhost-acceptance.py run --wait-lock --delivery /tmp/opencode/vrata-t17-final-9d7b2db
```

Предусловия запуска: exact `9d7b2db` опубликован в origin, относящиеся local gates успешны. Команда пока не выполнялась. Runner создаст новый clone origin на этом SHA; старый clone, env и project подставлять нельзя. По умолчанию `preflight`/`run` берут `/tmp/opencode/vrata-t17-browser.lock` без ожидания; код 75 означает занятую очередь, не провал продукта. `run --wait-lock` сериализует self-host с full local; второй внешний flock не нужен. Код 0 означает успешную выбранную операцию, 1 — failed lifecycle, 2 — ошибку runner; preflight exit 0 не является lifecycle PASS. Runner собирает собственные образы из source, поднимает штатный self-host и сохраняет результат независимо от исхода, отдельно пытаясь очистить только свои ресурсы. Повтор завершённого сценария автоматически не выполняется; исходные отказы не затираются. Ручной cleanup: тот же delivery и операция `cleanup` без `--wait-lock`, после проверки приватного terminal record.

Исторические подготовительные проверки `51668aa`: pristine clone/dependencies, stock/isolated Compose model, свободные порты/пустой project, collection 1 test. Первоначальные ошибки типов без workspace resolution сохранены; последующий полный tsc с mappings прошёл. Исправления оснастки `d3ec1ee` прошли 16/16 регрессий, полный tsc, два реальных read-only Compose config с одинаковым результатом при обычном и конфликтующем inherited env и ревью APPROVE без открытых замечаний. Вердикт не распространяется на bootstrap fix `9d7b2db` и не является self-host PASS.

После смены target на `9d7b2db` выполнены 16/16 регрессий, Python syntax, полный harness tsc, JSON parse/проверка пакета оснований и diff check. Старый dependency mapping использован только для TYPECHECK: `git diff 51668aa..9d7b2db` по `apps`, `packages`, `tests/e2e` и dependency manifests пуст; clone остался pristine. Это не fresh clone `9d7b2db`, не проверка его сборки и не runtime lifecycle: install/run/update/restart/disable/delete/storage audit/cleanup ещё предстоят.
