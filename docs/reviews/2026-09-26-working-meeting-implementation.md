# Рабочая встреча и room plugins: журнал реализации

Исходный план: `2026-09-25-working-meeting-and-room-plugins.md`.
Дата начала: 2026-09-26. Реализация идёт срезами; готовность всей встречи и внешних плагинов не заявляется.

## T01 — объединённый baseline

- Ветка реализации: `feat/working-meeting-room-plugins`, отдельный worktree.
- main: `18f3d8b4e19ec432d63cff83082af8a6a0cad476`.
- public-demo: `addb3996f80c65faac6ec5cb4a501eacb21af6e9`.
- Merge base: `54e13fec4ee14134597c6520a3cfa9b0db291032`.
- Merge commit: `388e5eb465db10ae326cbc0bca1ca769b19fa9a1`, обычный merge без конфликтов.
- Сохранены `document-surface-actions.ts`, ограничение DPR в functional screen-share test и muted/unmute UX.
- Исходный staging: `7cf806deb277b3d9b4c4744c03bb7c32c69e53a3`, successful run [36114986345](https://github.com/vrata-labs/platform/actions/runs/36114986345). Это сведения о baseline, не проверка новых изменений.
- Проверки merge: workspace build, 897 runtime tests, 6 reference E2E с отдельным PostgreSQL.
- Политика публикации завершённых срезов: commit, push, CI/Docker Publish, gated Staging Deploy и проверки exact SHA; разрешение пользователя получено.

## Подтверждённый дефект и первый срез T12

При обычном входе Host по приглашению в отдельную private meeting room сервер отклоняет неподдерживаемый DOCX: HTTP 400, `unsupported_document_mime`. Через очередной session-control poll текст ошибки заменялся на `Documents ready: 1`, а errorCode терялся. Это воспроизводимый дефект обратной связи. Исходный пользовательский файл не предоставлен, поэтому нельзя утверждать, что именно этот формат вызвал прежний отказ.

Причина: `applyAccessDebug` вызывал `renderDocumentsUi()` после каждого обновления прав, а render записывал стандартное сообщение вместо результата последнего действия. `finally` также обнулял errorCode.

Реализовано:

- Модель сообщений документов отделена от отрисовки. Фоновое обновление сохраняет результат, прогресс выводится из busy/loading flags.
- Upload/list orchestration вынесена из `main.ts`. Таймаут upload 60 s, AbortSignal, отмена при потере прав/завершении сессии/уходе со страницы, барьер устаревших ответов.
- Поздний список документов не удаляет только что загруженный PDF и его выбор. После потери upload permission список перечитывается, если просмотр ещё разрешён.
- Upload errors ограничены allowlist с понятными сообщениями. Произвольные server/storage details не попадают в UI.
- Shared local/staging public-demo scenario теперь загружает собственный трёхстраничный PDF через Host UI, проверяет uploadedBy, checksum, authenticated download с равенством байтов, страницы 1→2→3 и конкретный documentId после reload/late join. Unsupported-format case проверяет сохранение ошибки после полностью применённого session poll.
- Дополнительный файл удаляет существующий room-scoped cleanup сценария; материалы пользовательских комнат не используются.

Focused public-demo на локальном PostgreSQL прошёл целиком с четырьмя browser contexts. Этот результат не доказывает ручную слышимость или работу реальных Android/Quest устройств.

## Следующие обязательные этапы

- T01a: сначала предварительная поставка update/rejoin UI; затем server-issued identity v2, защита обоих refresh paths от legacy JWT laundering, admin-issued одноразовый recovery и enforcement. Сравнение публичного participantId не доказывает владение identity.
- T02–T03: SDK/threat model и отдельный QuickJS/WASM spike; author upload/runtime нельзя открывать до isolation/resource gates, включая реальный Android.
- T04–T10: package storage/API/UI, version/revision/lease lifecycle, platform seat correlation и внешние auto-seat/welcome-status пакеты.
- T11–T14: инструменты встречи, оставшаяся проверка документов, серверный Presenter revoke, handoff, доска и screen share.
- T15–T17: cleanup/backup/self-host, abuse/regression, exact-SHA CI/CD и ручная встреча.

T12 целиком остаётся открытой: этот срез закрывает воспроизведённый дефект, но ещё не выводит реальный лимит API и не закрывает всю матрицу storage failure/revoke/Android. T01a и plugin track ещё не реализованы.

## Публикация

Локально прошли workspace lint/typecheck/build/tests с PostgreSQL, затем runtime build и 905 runtime tests после финальных правок. Полный `pnpm test:e2e` на финальном исполняемом дереве: **148 passed**, без skip (41.6 min).

Первый full local запуск использовал отдельные E2E ports без явного BASE_URL: один старый helper обращался к 4000 вместо 4500, из-за чего 54 serial tests не запустились. Повтор выполнен с BASE_URL и теми же отдельными портами; код для обхода ошибки не менялся. В этом checkout `test:e2e` вызывает Playwright напрямую; аргументы focused specs передавались без лишнего `--`.

Итоговые SHA, CI/Docker/Staging runs и результаты staging/отката записываются после завершения gate.
