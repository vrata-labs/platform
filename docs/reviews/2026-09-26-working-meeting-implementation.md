# Рабочая встреча и room plugins: журнал реализации

Исходный план: `2026-09-25-working-meeting-and-room-plugins.md`.
Дата начала: 2026-09-26; обновлено 2026-09-28. **Опубликованы T01, исправление upload feedback из T12, предварительный update/rejoin клиент T01a-S1 и server identity/recovery foundations T01a-S2a.** Реализация идёт срезами; готовность всей встречи и внешних плагинов не заявляется.

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

T12 целиком остаётся открытой: первый срез закрывает воспроизведённый дефект, но ещё не выводит реальный лимит API и не закрывает всю матрицу storage failure/revoke/Android. Server-side identity v2 из T01a и plugin track ещё не реализованы.

### T01a-S1 — предварительный клиент обновления сессии, 2026-09-27

Реализован [контракт предварительной миграции](../arch/2026-09-27-room-identity-migration.md): точные REST/WS сигналы, терминальная блокировка старой сессии и reconnect, update/recovery dialog, сохранение черновиков в текущей вкладке и защита от повторного reload той же сборки. HTML требует revalidation. Добавлены одинаковые local/staging browser tests для будущего wire-контракта. Серверные identity v2 issuance/recovery/enforcement остаются следующим срезом; этот UI не закрывает T01a целиком.

Выявленная при проверке гонка shared/private editor устранена в notes runtime: dirty текст сохраняется под исходным scope до переключения; отказ сохраняет правильную принадлежность черновика. Cleanup failure не скрывает migration dialog и не пропускает media disconnect.

Локально S1: workspace lint/typecheck/build/tests с PostgreSQL и pinned rollback build прошли; runtime build/test — **920/920**. После окончательных изменений тестов полный `pnpm test:e2e` — **151/151** без skip (24.1 min).

| Этап T01a-S1 | Результат |
|---|---|
| Feature commit | `331860ae924e2bd88815baa657f100bdf332078c` |
| Итоговый опубликованный SHA | `22f38013d8242d13c752f03e29fc46d6265368b1` |
| [CI 36317985145](https://github.com/vrata-labs/platform/actions/runs/36317985145) | Success, включая полный local E2E и pinned asset checks |
| [Docker Publish 36317986588](https://github.com/vrata-labs/platform/actions/runs/36317986588) | Success, immutable images exact SHA |
| [Staging Deploy 36319499448](https://github.com/vrata-labs/platform/actions/runs/36319499448) | Success с первой попытки: **51/51 staging E2E**, **1/1 blocking Rutube**, successful SHA сохранён |

[Артефакт staging gate](https://github.com/vrata-labs/platform/actions/runs/36319499448/artifacts/10932750976) подтверждает все три migration UI сценария без retry, Host PDF upload/download, полный public-demo, Hall/BlueOffice/ArtGallery loaded и completed cleanup disposable demo room. Дополнительный public smoke: `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — 200. HTML комнаты и control plane возвращает `Cache-Control: no-cache`.

Предварительные Staging Deploy 36305828734 attempts 1–2 завершились 50/51 на старом muted audio join assertion; оба rollback успешно вернули `3912f70`. Измеренное влияние software rendering и последующие исправления синхронизации наблюдений описаны в [разборе functional render budget](2026-09-27-public-demo-render-budget.md). CI 36311907099 выявил две ошибки наблюдения: snapshot предыдущего кресла и слишком короткое ожидание guest PDF после 403; они исправлены отдельными test commits. Последний CI и staging gate прошли без повторов; последний rollback не запускался.

T01a-S2 — выдача server identity v2, безопасное восстановление и enforcement — **ещё не реализован**. Реальные устройства, включая выход из immersive XR при migration denial, в этой поставке не проверялись. Browser injection будущего denial DTO доказывает готовность UI, не серверную защиту от подмены identity.

### T01a-S2a — серверные identity/recovery primitives, 2026-09-27

Реализован [контракт хранения identity v2](../arch/2026-09-27-room-identity-storage.md): Node-only codec с HKDF-разделением ключей, identity без встроенных permissions, актуальная authority из storage, одноразовый room/role/expiry-bound recovery с хранением только хеша. При обновлении credential сохраняется identity ID; старый v1 JWT новый внутренний сервис не принимает.

Добавлены одинаковые Memory/PostgreSQL операции, CAS передачи Host, проверка epoch внутри транзакции, защищённые неизменяемые поля и атомарное потребление recovery. Проверены восемь параллельных предъявлений одного секрета, конкурирующие transfer/recover/revoke, чужие scope, истечение срока, rollback при ошибке записи consumed marker и сохранение старых private notes при разрешённом администратором legacy recovery.

После появления v2 authority старые записи owner/roomType/sessionControl/tenant отклоняются. Есть реальный SQL-тест ожидающего legacy UPDATE и проверка закреплённого старого build. Схема проверяет типы/NOT NULL, constraints, trigger source/metadata; сброс revision, consumed marker, epoch или удаление authority/tombstone при живой комнате запрещены. Первоначальная выдача Host ограничена revision 0; старый invite не позволяет занять освободившийся слот после передачи.

Фокусные проверки codec/storage/API с настоящим PostgreSQL и rollback build: **33 passed**, без skip. Workspace lint/typecheck/build и package tests прошли: API **807**, shared-types **24**, runtime **920**. Финальный полный local E2E: **151/151** (45.3 min). Первый E2E запуск остановился на существующем 5 s ожидании ray в визуальном seat-marker test; повтор того же дерева прошёл без правок runtime или E2E assertions.

API test files переведены на последовательный запуск: их fixtures делят database-wide migration advisory lock и при параллельном старте исчерпывали 120 s budget старого migration test. Явные конкурентные транзакции внутри тестов, включая восемь recovery attempts и гонку queued legacy UPDATE, сохранены.

Этот срез пока не подключает новый сервис к issuance/refresh/WS и не объявляет public v2 capability; исходные anti-spoofing гарантии плана требуют единого S2b включения.

| Этап T01a-S2a | Результат |
|---|---|
| Опубликованный SHA | `d82052ed711eaf6eeb7fcea28bd4f0889a64f8b0` |
| [CI 36346434992](https://github.com/vrata-labs/platform/actions/runs/36346434992) | Success |
| [Docker Publish 36346437663](https://github.com/vrata-labs/platform/actions/runs/36346437663) | Success, immutable images exact SHA |
| [Staging Deploy 36348405958](https://github.com/vrata-labs/platform/actions/runs/36348405958) | Success с первой попытки: **51/51 staging E2E**, **1/1 blocking Rutube**, successful SHA сохранён, rollback skipped |

[Артефакт staging gate](https://github.com/vrata-labs/platform/actions/runs/36348405958/artifacts/10942470804) подтверждает public-demo cleanup и Hall/BlueOffice/ArtGallery loaded. Дополнительный public smoke: `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — 200.

Последующая проверка обнаружила порядок миграции для очень старой схемы: identity triggers должны устанавливаться после добавления и нормализации `rooms.session_control`. Regression fixture теперь действительно начинается без этой колонки. Повторяющиеся задержки прежнего visual E2E отдельно исследованы в [CPU/GPU-профиле](2026-09-28-seat-marker-gpu-profile.md).

Локальная проверка этой корректировки и изоляции software-GPU очередей участников visual E2E: workspace lint/typecheck, API build и **807/807 API tests** с PostgreSQL/pinned rollback, **3/3 focused marker tests**, затем полный `pnpm test:e2e` — **151/151**, без skip/retry (24.9 min). Runtime, качество изображения, deadlines и assertions сценариев сохранены. Статус публикации корректировки фиксируется отдельно от уже принятого `d82052e`.

## Публикация первого среза T01/T12

Локально прошли workspace lint/typecheck/build/tests с PostgreSQL, затем runtime build и 905 runtime tests после финальных правок. Полный `pnpm test:e2e` на финальном исполняемом дереве: **148 passed**, без skip (41.6 min).

Первый full local запуск использовал отдельные E2E ports без явного BASE_URL: один старый helper обращался к 4000 вместо 4500, из-за чего 54 serial tests не запустились. Повтор выполнен с BASE_URL и теми же отдельными портами; код для обхода ошибки не менялся. В этом checkout `test:e2e` вызывает Playwright напрямую; аргументы focused specs передавались без лишнего `--`.

Отдельно выполнен первоначально пропущенный rollback contract test с PostgreSQL и точным build `33c7485ffa1773105c496b43542ea53bf4c5ae9a`: **1 passed**.

| Этап | Результат |
|---|---|
| Опубликованный runtime SHA | `3912f70363ce4b83eab5a638059740eaead1a60a` |
| [CI 36265587908](https://github.com/vrata-labs/platform/actions/runs/36265587908) | Success: lint/typecheck/build, package tests с PostgreSQL и rollback build, full local E2E, M0.5, pinned scene assets |
| [Docker Publish 36265590185](https://github.com/vrata-labs/platform/actions/runs/36265590185) | Success: immutable API/room-state/remote-browser images и проверенные registry manifests |
| [Staging Deploy 36267850481, attempt 2](https://github.com/vrata-labs/platform/actions/runs/36267850481/attempts/2) | Success: **48/48 staging E2E**, **1/1 blocking Rutube**, persisted successful SHA |

На опубликованном SHA проверены public room load, selector/navigation, обычный Host invitation → собственный PDF upload → authenticated download → страницы 1→2→3 → reload/late join, сохранение ошибки неподдерживаемого формата, shared notes и host controls. Hall/BlueOffice/ArtGallery достигли `loaded` на текущих browser pages. После gate `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` вернули HTTP 200.

Артефакт [playwright-staging-gate-36267850481-2](https://github.com/vrata-labs/platform/actions/runs/36267850481/artifacts/10915922115) содержит `host-own-document-upload`: trusted-invite Host, PDF 1481 bytes / 3 pages, upload 201, download 200, байты совпали, negative DOCX 400. Cleanup record: обе тестовые PDF-записи удалены, invites revoked, session ended, room/tenant deleted, phase completed. Raw приглашения и credentials в запись не включены.

### Повтор и откат

Attempt 1: **47/48**; второй audio client остался в `joining` после Join Audio Muted и не достиг `audioJoined=true` за 30 s. Host был `joined`; оба клиента имели scene loaded и подключённый room-state. Сценарий остановился до Host upload. Штатный rollback вернул `7cf806deb277b3d9b4c4744c03bb7c32c69e53a3`, подтвердил image tag и восстановление scene URLs; smoke после отката — HTTP 200.

Attempt 2 — один повтор **того же SHA**, без изменения кода, таймаутов и assertions: весь gate прошёл; rollback не запускался. Причина первого media join зависания не установлена. Успешный повтор не считается исправлением этой нестабильности: при её повторении нужны отдельные данные о стадиях token/connect/audio-device setup и bounded failure/recovery. Этот вопрос остаётся в проверках устойчивости встречи T17.

Реальные Android/Quest и четыре человека с микрофонами в этом срезе не проверялись. Synthetic audio source с настоящим LiveKit transport не закрывает WM-11/WM-12 manual acceptance.
