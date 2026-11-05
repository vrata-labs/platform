# T17: карта приёмки

Runtime: `51668aa26f64dc6d56045ac9bff6a14b1038f129` (main, PR #156). Docs/harness SHA записывается отдельно после фиксации оснастки. Изменение только отчёта не означает новую сборку runtime; любое исполняемое изменение продукта требует нового runtime SHA и повторных относящихся проверок.

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

- Новый отдельный clone получен с origin и переключён на exact runtime SHA; это ещё не self-host PASS.
- Штатные инструкции: `docs/self-hosting.md`, `docs/demo/README.md`, `docs/plugin-storage-lifecycle.md`; Compose selfhost+demo-local. Существующий `storage-lifecycle.spec.ts` использует fixture и не подменяет fresh clone.
- Linux Docker socket отсутствует; доступен Windows Docker Engine 29.4.1 и Compose 5.1.3 через named pipe. Перезапуск Docker/WSL/сети не требуется.
- Local/CI/stage и ручная встреча имеют отдельные подтверждения; здесь они не объявлены выполненными.

## Запуск fresh self-host

Оснастка: `tools/t17-selfhost-acceptance.py`; отдельный Playwright config: `tests/selfhost/playwright.config.ts` (без webServer/fixture). Продукт собирается штатными Dockerfiles из `git archive` exact runtime SHA. Author helpers сверяются побайтно с этим SHA; hashes самой оснастки записываются отдельно. Приватные env, state и логи — только в каталоге доставки вне репозитория.

```bash
python3 tools/t17-selfhost-acceptance.py preflight
python3 tools/t17-selfhost-acceptance.py run
```

Оба запуска по умолчанию берут `/tmp/opencode/vrata-t17-browser.lock` без ожидания; код 75 означает занятую очередь, не провал продукта. Долгий `run` выполняется последовательно с full local. Для асинхронной очереди главного процесса предусмотрен `run --wait-lock`; внутри дочерней задачи ожидание не запускается. Не оборачивайте runner во второй flock: он сам владеет lock. Он не ждёт CI/публикации образов: собирает новые собственные образы из source, поднимает штатный self-host и в любом исходе сохраняет результат/пытается очистить только свои ресурсы. Повтор завершённого сценария автоматически не выполняется; исходные отказы не затираются. Ручное завершение cleanup: та же команда с операцией `cleanup` после проверки приватного terminal record.

Выполнены только подготовительные проверки: pristine clone/dependencies, штатный и изолированный rendered Compose model, свободные уникальные порты/отсутствие ресурсов project, Playwright collection 1 test. Они не равны install/run/restart PASS. Отдельная первоначальная проверка типов без workspace resolution завершилась ошибками разрешения зависимостей; её журналы сохранены. Полная проверка типов оснастки с pristine dependency/source mappings включена в runner до сборки контейнеров. Браузерный lifecycle передан в общую последовательную очередь: lock занят, ожидание и фоновый запуск не производились.
