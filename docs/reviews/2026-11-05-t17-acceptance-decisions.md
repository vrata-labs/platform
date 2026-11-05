# T17: решения и границы приёмки

## D-098 — 2026-11-05 — Runtime SHA отделён от документации и оснастки
- Контекст: T17 проверяет окончательный main `51668aa26f64dc6d56045ac9bff6a14b1038f129`, а отчёт и оснастка появляются после него.
- Решение: продукт собирается из нового clone origin на этом exact SHA, без копирования dist/node_modules/БД прежних приёмок. Docs/harness SHA и hashes сценария записываются отдельно; ими нельзя подменять provenance runtime.
- Штатный путь: selfhost+demo-local Compose, отдельные случайные credentials и volumes, публичный SDK с работающего self-host и существующие author/UI/authority helpers. Fixture API не является этим self-host.
- Изоляция: уникальные project/ports и labels `vrata.task=T17`/run ID на контейнерах, volumes и сети. Удаляются только совпавшие owned resources. Browser/preflight выполняются под общим неблокирующим lock; занятый lock означает передачу запуска, не ожидание.
- Проверка: новый clone origin, frozen install и collection одного сценария выполнены; stock model прошёл штатный validator, изменения изоляции и пустой project проверены отдельно. Новый сценарий использует настоящую reference scene и normal-DPR render без frame-budget override. Первоначальный отдельный tsc без mappings не разрешил transitive workspace imports; mappings в runner направляют их на тот же pristine source/dependencies, без изменения продукта. Контейнерный lifecycle ещё не выполнен: общий browser lock занят, запуск передан в последовательную очередь. До результата не закрывать подпункт плана.

## D-099 — 2026-11-05 — Исключения T16 не переносятся на T17
- Каждый WM имеет строку в карте evidence; final local/CI/Docker/stage и устройства обязательны отдельно. Старые failed/skipped/stale сохраняются.
- Автоматический self-host проверяет поставку и внешний lifecycle, но не ручную встречу, производительность, Android touch/capture/view или слышимость. Сцена, рендер, TTL, бюджеты и assertions продукта не ослабляются ради результата.
- Stage/его аренда и публикация принадлежат отдельному контуру проверки; эта self-host оснастка к ним не обращается.
