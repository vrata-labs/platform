# Рабочая встреча и room plugins: журнал реализации

Исходный план: `2026-09-25-working-meeting-and-room-plugins.md`.
Дата начала: 2026-09-26; обновлено 2026-09-30. **Опубликованы T01, исправление upload feedback из T12, предварительный update/rejoin клиент T01a-S1 и server identity/recovery foundations T01a-S2a.** Реализация идёт срезами; готовность всей встречи и внешних плагинов не заявляется.

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

Локальная проверка этой корректировки и изоляции software-GPU очередей участников visual E2E: workspace lint/typecheck, API build и **807/807 API tests** с PostgreSQL/pinned rollback, **3/3 focused marker tests**, затем полный `pnpm test:e2e` — **151/151**, без skip/retry (24.9 min). Runtime, качество изображения, deadlines и assertions сценариев сохранены.

#### Публикация корректировки, 2026-09-28

| Этап | Результат |
|---|---|
| Legacy migration commit | `04d28a2` |
| Итоговый опубликованный SHA | `954a976af3d7352fa54ce1454f63ecc1d082694d` |
| [CI 36445814337](https://github.com/vrata-labs/platform/actions/runs/36445814337) | Success с первой попытки, включая полный E2E, M0.5 и pinned asset checks |
| [Docker Publish 36445815313](https://github.com/vrata-labs/platform/actions/runs/36445815313) | Success с первой попытки, immutable images exact SHA |
| [Staging Deploy 36448517194, attempt 2](https://github.com/vrata-labs/platform/actions/runs/36448517194/attempts/2) | Success: **51/51 staging E2E**, без skip/retry (29.0 min); successful SHA сохранён; rollback skipped |
| Rutube canary того же run | **1/1**, без skip/retry; отдельный non-blocking canary согласно пути изменений |

[Артефакт gate](https://github.com/vrata-labs/platform/actions/runs/36448517194/artifacts/10985861541) подтверждает обе visual occupancy проверки, owner-bound workspace, public-demo с настоящим LiveKit, собственным Host PDF и completed cleanup (documents deleted, invites revoked, session ended, room/tenant deleted). Hall/BlueOffice/ArtGallery достигли loaded на текущих страницах. [Артефакт canary](https://github.com/vrata-labs/platform/actions/runs/36448517194/artifacts/10986356063). После gate `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — 200.

**Первый attempt и откат:** 49 passed, 1 flaky, 1 failed. Обе проверки маркеров прошли. Reference UI test получил 0 `.template-card` вместо 3 за 5 s; snapshot показывал `admin-token-pending` и незаполненные каталоги. Отдельный прежний remote mock VR hands test исчерпал 45 s и прошёл свой предусмотренный retry. Штатный rollback вернул `d82052ed711eaf6eeb7fcea28bd4f0889a64f8b0`, подтвердил image tag, восстановил оба scene URL и прошёл smoke. После него публичные API/control-plane отвечали 200. Выполнен один полный повтор того же SHA, без изменений кода, deadlines и assertions; он прошёл целиком.

Причина первого gallery bootstrap stall не установлена: network trace этого запроса отсутствует. Успешный повтор не считается исправлением галереи или flaky hands test. В проверках устойчивости T17 остаётся сбор network/bootstrap timing при повторении gallery stall и сохранение исходной ошибки при timeout/cleanup remote-hands сценария.

### T01a-S2b-B — обязательная граница безопасного отката

До публичного включения v2 подготовлен [контракт активации](../arch/2026-09-28-room-identity-activation.md) и совместимый промежуточный образ B. Старый образ после rollback не должен вновь разрешать v1-доступ к уже защищённым данным. Публичная v2 выдача и принятие серверного ID клиентом в B не включаются; минимальный протокол общего staging при его поставке остаётся 1.

Реализованы atomic lifecycle-переходы Host/Owner/Presenter, lock/unlock/end/remove с проверкой текущей identity и CAS под блокировкой комнаты. Lifecycle хранится в authority; legacy JSON остаётся замороженным. Проверены перенос схемы S2a, неизменность прежних guard-функций, гонки, recovery после transfer и legacy-ID `constructor`/`toString`/`__proto__`.

Добавлен глобальный монотонный минимум протокола. При 2 образ B отказывает issuance, обоим refresh, защищённым REST и WS, включая живые подключения; отказ чтения policy не превращается в разрешение. Администратор сохраняет доступ к метаданным. Проверка на отдельной PostgreSQL БД запускает настоящий опубликованный API `954a976`: при минимуме 1 он работает, при 2 не проходит проверку guard; возврат B сохраняет заметки, identity и минимум. Staging/production/self-host rollback-проверки запрещают старые образы также при наличии authority binding до общего переключения.

Общий staging действительно подписывал state JWT ключом разработки: это проверено сравнением подписи одного гостевого токена, без публикации самого токена. Пользователь разрешил заменить ключ случайным через штатный pipeline и подтвердил допустимость отключения старых invite-ссылок, использующих тот же HMAC-ключ. Для ручного запуска добавлен `rotate_dev_state_secret=true`: ключ генерируется только на VM, сохраняется атомарно с правами 0600 и не возвращается в CI. Retry не меняет уже настроенный ключ; rollback образа не возвращает ключ разработки.

Пакетные проверки: workspace lint/typecheck/build; API **822/822**, room-state **72/72**, shared-types **26/26**, runtime **920/920** на промежуточном дереве. Исправлено обнаружение API-тестов: новый тест в подпапке выявил shell expansion, исключавший корневые файлы; glob теперь передаётся самому Node в кавычках. Focused E2E подтвердили реальный отказ сервера, защиту черновика, сохранение минимума после restart, обычное присутствие четырёх клиентов и media commands. Есть безопасный staging-facing negative case для obsolete development-key credential; поднятие самого минимума выполняется только в изолированной тестовой БД.

В первом полном local E2E после этих изменений пройдено 152/153. Не завершилось ожидание Host remove в существующем public-demo; следующий отдельный прогон остановился на PDF Guest page 2. [Профиль четырёх клиентов](2026-09-28-four-client-gpu-diagnosis.md) показал длительное ожидание программного GPU при полученных HTTP-ответах. Изоляция четырёх браузеров и снижение DPR не помогли и отменены. Исправлена гонка между `toBeEnabled()` и DOM `click()` для кнопок Host; focused public-demo после правки прошёл целиком, без изменения пикселей, runtime и лимитов ожидания. Следующий полный E2E выявил ещё одну гонку: тест screen-share Guest принимал физическую debug-поверхность за готовый серверный snapshot. После ожидания логической allowlist весь focused screen-share spec прошёл (4/4). На окончательном исполняемом дереве полный local E2E — **153/153**, без skip/retry (22,6 минуты). Минимум 2 в общем staging не поднимался.

Итоговая поставка B прошла полный локальный `pnpm test:e2e` на финальном исполняемом дереве: **153/153**, без retry/skip, 22,5 минуты. Локальная проверка нового исходного импорта: 2/2 focused identity E2E. Общий минимум протокола в staging остался 1; публичная v2 выдача ещё не объявляется.

| Этап T01a-S2b-B | Результат |
|---|---|
| Основной срез | `5dfb530fe6d20e66e2e5d72af5b6ff055592047a` |
| CI checkout mode fix | `8a3f8b916b0dd07bee6f9da2e0f3a60b39056905` |
| Итоговый исполняемый и проверенный SHA | `033bd6e2b33e9149221464c934554977320ca36f` |
| [CI 36647780130](https://github.com/vrata-labs/platform/actions/runs/36647780130) | Success с первой попытки данного SHA: package tests, полный local E2E, M0.5, pinned scene checks |
| [Docker Publish 36647779978](https://github.com/vrata-labs/platform/actions/runs/36647779978) | Success с первой попытки: API, room-state, remote-browser images exact SHA |
| [Staging Deploy 36650600289](https://github.com/vrata-labs/platform/actions/runs/36650600289) | Success с первой попытки данного SHA: **52/52 staging E2E**, **1/1 blocking Rutube** без flaky/skip; persisted successful SHA, rollback skipped |

[Артефакт staging gate](https://github.com/vrata-labs/platform/actions/runs/36650600289/artifacts/11071596015): реальный API отклоняет старый dev-key credential, Host загружает и показывает собственный PDF для четырёх участников с настоящим LiveKit, сохранение notes и полная cleanup запись; owner-bound workspace и обе visual occupancy комнаты проходят. Hall/BlueOffice/ArtGallery достигли loaded на текущих страницах. После gate `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` вернули 200. Гостевой token пробного входа имеет валидный ответ 200 и **не** подписан прежним ключом разработки; сам token и новый ключ не опубликованы.

Промежуточные попытки: [CI 36636543721](https://github.com/vrata-labs/platform/actions/runs/36636543721) остановился до тестов на изменении mode закреплённого bin-файла после pnpm install; точный mode восстановлен, [CI 36639398975](https://github.com/vrata-labs/platform/actions/runs/36639398975) прошёл. [Staging Deploy 36642592194](https://github.com/vrata-labs/platform/actions/runs/36642592194) провёл разовую ротацию ключа, 51/52 staging tests прошли, но новый тест импортировал локальный dist-файл, которого нет у staging runner. Штатный rollback вернул предыдущий образ, не вернув общеизвестный ключ. Импорт заменён на исходный модуль; повтор B опубликован новым SHA через обычный pipeline. При повторе ротация осталась idempotent (`already_configured`). Старые state-токены и приглашения по согласованию требуют повторного входа/перевыпуска.

Активация V остаётся отдельным последующим шагом: proof-bound waiting room/owner bootstrap, v2 JWT/admission/refresh/recovery, свежая authority и принятие server ID до первого publish, изоляция старых media credentials. Успешная подготовка rollback границы не является закрытием T01a и не даёт прав автора внешнего плагина.

### T01a-S2b-V foundations — в работе

После приёмки B в отдельном непубличном срезе собраны v2 session codec (без роли/permissions), выдача свежего server ID по проверенному инвайту и одноразовому ожиданию, атомарное создание личной комнаты с доказанным владельцем. Старый инвайт маркирован протоколом 1 и не может получить v2 Host; Host из legacy-комнаты восстанавливается отдельно. Общий внутренний verifier на API и live room-state WS проверяет текущую authority перед эффектом, а поздний ответ со старой revision не повышает роль обратно. Негативные и race проверки Memory/PostgreSQL, клиентское подставление participantId, перенос Host → Member и отзыв сокета проверяются локально в отдельных схемах.

На окончательном локальном дереве workspace lint/typecheck/build, package tests (API **841/841**, shared-types **30/30**, room-state **76/76**, runtime **920/920**) и полный E2E **154/154**, без skip/retry (22,6 минуты). Один промежуточный полный прогон дал 153/154: старый клиент после появления v2 issuance корректно получил HTTP 426 вместо прежнего 409; test expectation приведён к опубликованному upgrade DTO, остальные проверки не менялись. Отдельный локальный браузерный тест с реальными API, room-state и PostgreSQL показывает 4406 для v1, отказ подставленному participantId, live Host transfer → Member и закрытие после revoke. Восемь конкурентных предъявлений одного waiting proof дают ровно одного победителя. PG migration совместима с точной опубликованной rollback-версией B `033bd6e` при достигнутом minimum 2 — проверено на отдельной схеме.

Публикация этого среза на staging сохраняет минимальную версию протокола 1 и прежние пользовательские маршруты: открытых авторских plugin routes или публичного v2 join пока нет. Для реальной активации остаются: проектирование retention/rate-limit identity, вся схема runtime adoption, private notes/owner semantics и остальные REST writes, admin recovery endpoints, строгая media namespace и полноценные E2E на итоговом SHA. До их готовности повышать минимум до 2 нельзя.

| Этап T01a-S2b-V foundations | Результат |
|---|---|
| Итоговый опубликованный SHA | `dbc27c1fdd77e2a941f059c458ad42c21d3374c7` |
| [CI 36666534506](https://github.com/vrata-labs/platform/actions/runs/36666534506) | Success с первой попытки: package tests, полный local E2E, M0.5 и закреплённые scene checks |
| [Docker Publish 36666534723](https://github.com/vrata-labs/platform/actions/runs/36666534723) | Success с первой попытки: образы точного SHA |
| [Staging Deploy 36669028596](https://github.com/vrata-labs/platform/actions/runs/36669028596) | Success с первой попытки: **52/52 staging E2E**, **1/1 blocking Rutube**, без flaky/skip, successful SHA сохранён, rollback skipped |

[Артефакт gate](https://github.com/vrata-labs/platform/actions/runs/36669028596/artifacts/11078606345): старый dev-key credential отвергнут, четырёхсторонняя встреча с LiveKit и PDF проходит с cleanup, owner-bound workspace и visual seat marker tests зелёные. Hall, BlueOffice, ArtGallery loaded. После gate `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — 200. Ни floor 2, ни v2 credentials не выдавались на общем staging. Новая схема проверена против точного опубликованного rollback-образа B в отдельной PostgreSQL базе с floor 2; это не hot rollback на общем staging.

### T01a-S2b-V: подготовка HTTP и runtime к координированной активации

На отдельной схеме PostgreSQL при minimum 2 теперь работают v2 HTTP admission и актуальная REST authority: одноразовый waiting proof, настоящие v2 invitations, session-control lifecycle, личная комната с доказанным владельцем и отдельный media namespace для браузера и remote-browser executor. Client boot принимает серверный participant ID до room-state/presence, хранит proof отдельно от публичного ID в текущей вкладке, обновляет сессию до истечения срока и повторно подключает WS. Посадка и media/аватарные фабрики не должны сохранять старый ID вкладки. Унаследованные body-only media credentials не допускают повышения роли из v1.

Браузерная проверка в disposable PG схеме с minimum 2: старый live v1 получает отказ и сохраняет несохранённый черновик; новая вкладка присоединяется с server ID и сохраняет его после reload; личная комната повторно открывается из той же вкладки только по proof; скопированный публичный ID не даёт доступа; WS отзывает права после Host transfer/revoke. Два реальных дефекта нашлись именно здесь: JSON `null` для отсутствующих proof/invite полей превращался в отказ admission, а fallback presence не пересылал v2 session и запускал ложный upgrade dialog. Оба исправлены; focused identity E2E **4/4** без retry.

Проверки подготовительного среза: workspace lint/typecheck/build; API с настоящим PostgreSQL и закреплёнными storage rollback builds **845/845** (старый pre-boundary API проверяется отдельным контрактом без подмены на совместимый B), runtime **926/926**, room-state **76/76**, shared-types **30/30**. Финальный полный local E2E на текущем исполняемом дереве: **155/155** без skip/retry (14,6 минуты), включая четыре клиента, LiveKit, PDF, notes, visual seat markers и новые v2 браузерные сценарии. Общий staging остаётся на minimum 1: в этом срезе запрещено поднимать floor 2 или объявлять готовность T01a.

До координированной активации остаются admin recovery HTTP и owner hand-off, retention/rate-limit для анонимной выдачи durable identities, полная проверка приватных материалов и всех effect-bearing REST routes после отзыва прав, жизненный цикл legacy Host/Owner, media executor в production и тесты обоих refresh путей после истечения срока. Плагины, QuickJS/WASM sandbox и author routes по-прежнему не реализованы.

| Этап подготовительного T01a-S2b-V | Результат |
|---|---|
| Проверенный и опубликованный SHA | `6144cccc6bb6a254c720e74d95fab85b47bbb98d` |
| [CI 36686256127](https://github.com/vrata-labs/platform/actions/runs/36686256127) | Success: package tests, полный local E2E, M0.5 и закреплённые asset checks |
| [Docker Publish 36686256167](https://github.com/vrata-labs/platform/actions/runs/36686256167) | Success: immutable API, room-state и remote-browser images точного SHA |
| [Staging Deploy 36689309883](https://github.com/vrata-labs/platform/actions/runs/36689309883) | Success с первой попытки: **52/52 staging E2E**, **1/1 blocking Rutube**, successful SHA сохранён; rollback skipped |

[Артефакт staging gate](https://github.com/vrata-labs/platform/actions/runs/36689309883/artifacts/11085983559): четыре участника, собственный PDF и notes, загрузка Hall/BlueOffice/ArtGallery на текущих страницах, XR seat/telemetry сценарии и полный cleanup. Дополнительный public smoke после gate: `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — 200. `/health.features` не содержит identityProtocolVersion: минимум общего staging по-прежнему 1, v2 здесь не проверялся и не активировался. В этом run откат не понадобился.

### T01a-S2b-V: администраторское восстановление legacy Host/Owner

Следующий подготовительный срез добавляет HTTP-маршрут выдачи одноразового room/role-bound recovery только для проверенного admin-token. Выдача не принимает legacy JWT или один лишь публичный participant ID за полномочие администратора; storage проверяет текущий legacy Host/Owner и revision. Proof действителен десять минут, возвращается только в ответе `no-store` и не попадает в URL/логи. Пользователь вводит код в **Recover room access** — в HUD или в диалоге уже заблокированной старой сессии. Отдельный proof-only обмен выдаёт server identity, сохраняет её в текущей вкладке и обновляет страницу; старые токены и ID в запрос не отправляются.

Изолированные PostgreSQL проверки покрывают выдачу Host и Owner, сохранение прежнего личного ID/private state, отказ без admin-token, ошибочный target, wrong room, истечение срока и replay. Браузерные сценарии проверяют оба пути UI: private owner при отказе входа и legacy Host из терминального upgrade dialog после того, как новая v2-вкладка уже вошла в ту же комнату. Общий staging остаётся на minimum 1; активация всё ещё заблокирована отсутствием retention/rate-limit, owner hand-off и окончательного REST/media enforcement.

Локальная проверка: workspace lint/typecheck/build, API с PostgreSQL и pinned rollback storage **845/845**, runtime **928/928**, room-state **76/76**, shared-types **30/30**. Первый полный прогон с четырьмя workers обнаружил три задержки в GPU-нагруженных reference/аватарных сценариях; все три прошли отдельно без изменения исполняемого кода. Последующий serial E2E выявил настоящую гонку: кнопку «Open my room» можно было нажать до server-ID boot. Кнопка теперь недоступна до завершения boot, а сценарий ждёт её активного состояния. Финальный полный local `pnpm test:e2e --workers=1` на окончательном исполняемом дереве — **156/156**, без skip/retry (30,3 минуты). Это не проверка на общем staging до публикации exact SHA.

| Этап recovery-подготовки | Результат |
|---|---|
| Проверенный и опубликованный SHA | `14f6a046574a166a02e1fa6a8774b4cd70b5aa14` |
| [CI 36706837714](https://github.com/vrata-labs/platform/actions/runs/36706837714) | Success: package tests, полный E2E, M0.5 и закреплённые asset checks |
| [Docker Publish 36706837710](https://github.com/vrata-labs/platform/actions/runs/36706837710) | Success: immutable API, room-state и remote-browser images точного SHA |
| [Staging Deploy 36710133398](https://github.com/vrata-labs/platform/actions/runs/36710133398) | Success с первой попытки: **52/52 staging E2E**, **1/1 blocking Rutube**; successful SHA сохранён, rollback skipped |

[Артефакт staging gate](https://github.com/vrata-labs/platform/actions/runs/36710133398/artifacts/11094848416) подтверждает встречу с собственным PDF, notes, полный cleanup и текущую загрузку Hall/BlueOffice/ArtGallery. После gate `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — 200. В `/health.features` нет identityProtocolVersion: публичная v2 выдача на общем staging не активировалась, так что изолированные recovery E2E не выдаются за staging-проверку floor 2. Откат этого run не потребовался.

### T01a-S2b-V: ограничение анонимной выдачи identity

До активации v2 ограничивается количество новых room-bound identities: 180 новых входов в минуту и 3000 в сутки с одного аутентифицированного сетевого источника, 20/час и 100/сутки для создания личных комнат. Источник от Caddy принимается только с отдельным проверенным proxy key; прямой API игнорирует неподписанный forwarded адрес. В PostgreSQL счётчики разделяются всеми API-репликами, содержат только HMAC источника и периодически очищаются после закрытия окна. Существующий room proof, ожидание после одобрения и администраторское восстановление не расходуют квоту новых входов.

Запрещённое контрактом отката удаление identity при живой комнате не заменяется принудительной очисткой. Вместо этого установлен lifetime cap 10 000 identity и 50 000 waiting records на комнату; по достижении лимита новая выдача получает 429, но действующие владельцы продолжают обновлять свои credentials. Ключи источников не сохраняются в явном виде. Проверки Memory/PostgreSQL охватывают границы и конкурентные выдачи; изолированный HTTP/browser сценарий проверяет 429 для новой вкладки и успешный reload вкладки с proof. Для длительно живущих комнат остаётся необходимым управляемое архивирование/замена, до которого общий staging не переводится на floor 2.

Первая попытка [Staging Deploy 36786227651](https://github.com/vrata-labs/platform/actions/runs/36786227651) остановилась до запуска новой версии: прежний checkout потребовал отсутствующий в staging .env внутренний ключ даже для `docker compose config`. Шаг rollback завершился с той же ошибкой; публичные health, room и control-plane продолжили отвечать 200, но успешный откат этим run не подтверждён. Вторая попытка [36802220925](https://github.com/vrata-labs/platform/actions/runs/36802220925) успешно создала на хосте отдельный proxy key, однако read-only preflight предыдущего checkout всё ещё требовал старый ключ, поэтому и rollout, и rollback снова прервались до переключения сервисов. Причина устранена без подмены service/state keys: preflight допускает временное значение исключительно для чтения уже работающего PostgreSQL через старый Compose; значение не пишется в env и никогда не используется для запуска контейнера. При активированном floor 2 отсутствие настоящего внутреннего ключа по-прежнему запрещает переход.

Генератор isolated public-demo env дополнен собственным независимым proxy key: CI [36795003781](https://github.com/vrata-labs/platform/actions/runs/36795003781) обнаружил забытый Compose overlay, исправленный в следующем SHA. На окончательном дереве workspace lint/typecheck/build и полный `pnpm test` с PostgreSQL/pinned rollback: API **852/852**, runtime **928/928**, room-state **76/76**, shared-types **30/30**, tools **125/125**. Локальный полный `pnpm test:e2e --workers=1` — **157/157** без skip/retry (25,3 минуты). Несколько промежуточных локальных прогонов под общей загрузкой завершались таймаутами в разных сценариях; source-quality assertions и runtime ради них не ослаблялись.

| Этап ограничения выдачи v2 | Результат |
|---|---|
| Проверенный и опубликованный SHA | `fa13bd06e91d9f05f7a2a39ab8947262953e44a2` |
| [CI 36805732528](https://github.com/vrata-labs/platform/actions/runs/36805732528) | Success: package tests, полный E2E, M0.5 и закреплённые asset checks |
| [Docker Publish 36805732479](https://github.com/vrata-labs/platform/actions/runs/36805732479) | Success: immutable API, room-state и remote-browser images точного SHA |
| [Staging Deploy 36808559694](https://github.com/vrata-labs/platform/actions/runs/36808559694) | Success: **52/52 staging E2E** и **1/1 blocking Rutube**; successful SHA сохранён; rollback skipped |

[Артефакт staging gate](https://github.com/vrata-labs/platform/actions/runs/36808559694/artifacts/11139657823): четырёхсторонняя встреча и cleanup, текущая загрузка Hall, BlueOffice и ArtGallery. Дополнительный public smoke после gate: `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — HTTP 200. Proxy key сохранён без повторной ротации (`already_configured`); общий staging остался на floor 1. Реальные v2 429/proof сценарии проверены на отдельной схеме PostgreSQL, не на общем staging.

### T01a-S2b-V: явная передача владельца личной комнаты

Подготовлен CAS-маршрут owner/transfer для room-bound v2 identity. Администратор может создать личную комнату от имени другого человека, выдать ему v2 invite и лишь после доказанного входа передать owner authority по server-issued participant ID и текущей revision. Одного ownerParticipantId из метаданных комнаты недостаточно. Текущий владелец может так же передать права из HUD приглашённому участнику; Host остаётся отдельным слотом по принятому контракту. Участник с ролью Member и актуальным isOwner видит управление своей личной комнатой, а бывший владелец теряет доступ к owner-only personal state. В старых session-control DTO новых полей нет; runtime принимает их только от v2-сессии и игнорирует ответы со старой authority revision.

В Memory/PostgreSQL проверены гонки CAS, чужой ID, отозванный и cross-room target, отсутствие автоматического наследования Host, отзыв recovery после передачи. Реальный API и браузер подтверждают admin-to-recipient и owner-to-recipient handoff, право нового владельца управлять комнатой даже в роли Member, live update и reload. На общем staging floor 2 не поднимается до окончания проверки всех effect-bearing REST/media действий и политики архивирования длительно живущих комнат.

Локально прошли lint/typecheck/build, пакетные тесты с PostgreSQL и pinned rollback: API **854/854**, runtime **931/931**, room-state **76/76**, shared-types **30/30**, tools **125/125**; identity-browser spec **7/7**. Полный local E2E на окончательном дереве запускался дважды: под нагрузкой программного рендеринга первый дал 157/158 с отказом старого seat-marker сценария (он отдельно прошёл), второй — 146 успешных, 6 таймаутов в прежних сценах/media и 6 незапущенных. Полный E2E изолированного CI для exact SHA прошёл; локальный полный прогон зелёным не объявляется.

| Этап передачи владельца | Результат |
|---|---|
| Проверенный и опубликованный SHA | `597d917212c78ec442d94df151151642aec0d164` |
| [CI 36837708041](https://github.com/vrata-labs/platform/actions/runs/36837708041) | Success: пакетные тесты, полный E2E, M0.5 и pinned assets |
| [Docker Publish 36837710736](https://github.com/vrata-labs/platform/actions/runs/36837710736) | Success: immutable images exact SHA |
| [Staging Deploy 36864044918](https://github.com/vrata-labs/platform/actions/runs/36864044918) | Success: **52/52 staging E2E**, **1/1 blocking Rutube**, successful SHA сохранён; rollback skipped |

Первые три gated запуска точного SHA — [36841653380](https://github.com/vrata-labs/platform/actions/runs/36841653380), [36849194733](https://github.com/vrata-labs/platform/actions/runs/36849194733), [36858902675](https://github.com/vrata-labs/platform/actions/runs/36858902675) — не прошли из-за разных таймаутов входа, сцен и media. Каждый штатно откатился на предшествующий successful SHA. В сетевых артефактах Hall GLB вернул HTTP 200, но за ~42 секунды была доставлена только часть 18,9 МБ; затем тот же asset отдавался целиком за ~3 секунды. Runtime/scene сроки и проверки не ослаблялись. Четвёртый запуск без изменения исполняемого кода прошёл полностью.

[Артефакт успешного gate](https://github.com/vrata-labs/platform/actions/runs/36864044918/artifacts/11165215941): Hall, BlueOffice и ArtGallery загрузились на текущих страницах, встреча и cleanup завершились; последующий public smoke `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — 200. Общий staging по-прежнему на identity floor 1: end-to-end v2 handoff проверен локально и в CI-изолированных тестах, не заявлен активным на общем хосте.

### T01a-S2b-V: повторная проверка перед эффектом

Подготовлены post-sign authority checks для media/frame-токенов и проверка текущей комнаты/исполнителя remote-browser media. Записи заметок и публикация/привязка/удаление документов используют короткую DB-only границу с блокировкой родительской комнаты. Authority и изменение данных выполняются на одном соединении, в READ COMMITTED; S3 и room-state RPC остаются снаружи транзакции. После принятого удаления документ скрыт независимо от внешней очистки; сохранённый tombstone допускает авторизованный повтор DELETE. Уже открытый frame socket закрывается по сроку proof и не принимает новые сообщения после него.

Регрессии проверяют запись против revocation в обоих порядках, пул размером один, конкурентные записи и rollback частичной записи. Реальный API проверяет задержанный body заметки/upload/surface, отзыв media/frame credentials во время запроса и повтор cleanup после сбоя с отказом прежнему Host. Новая граница не объявляется полным решением отзыва self-hosted LiveKit JWT: текущая документация подтверждает отсутствие server-side revocation и обновление токенов активных соединений. Активация общего floor 2 всё ещё запрещена до remaining REST/media gate.

Локально прошли workspace lint/typecheck/build, полный `pnpm test` с PostgreSQL и pinned rollback: API **858/858**, remote-browser **39/39**, runtime **931/931**, room-state **76/76**, shared-types **30/30**, tools **125/125**. Первый full E2E дал 157/158 — прежний guest screen-share сценарий не дождался отказа за 10 секунд и затем отдельно прошёл без правок. Финальный полный local `pnpm test:e2e --workers=1` на том же исполняемом дереве — **158/158**, без skip/retry (33 минуты). Внешние media/JWT, полученные до revocation, не объявляются отозванными этим срезом.

| Этап повторной проверки перед эффектом | Результат |
|---|---|
| Проверенный и опубликованный SHA | `2aa3f9e64547ffb6837cde88a1a8764cc14b85d6` |
| [CI 36944286362](https://github.com/vrata-labs/platform/actions/runs/36944286362) | Success: пакетные тесты, полный E2E, M0.5 и pinned assets |
| [Docker Publish 36944286292](https://github.com/vrata-labs/platform/actions/runs/36944286292) | Success: immutable API, room-state и обновлённый remote-browser exact SHA |
| [Staging Deploy 36946624938](https://github.com/vrata-labs/platform/actions/runs/36946624938) | Success с первой попытки: **52/52 staging E2E**, **1/1 blocking Rutube**; successful SHA сохранён; rollback skipped |

[Артефакт staging gate](https://github.com/vrata-labs/platform/actions/runs/36946624938/artifacts/11203496839): Hall/BlueOffice/ArtGallery loaded на текущих страницах, встреча с собственными материалами и cleanup завершились. После gate `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — 200. Общий identity floor остался 1, post-revoke v2 effects проверены на изолированных PostgreSQL/API тестах. Retry/rollback этой публикации не потребовались.

### T01a-S2b-V: personal-state и выдача приватных ответов

Personal-state GET/PUT повторно проверяют действующего владельца. PUT берёт правильную блокировку комнаты заранее, меняет только personal_state и выполняется на одном соединении. Общий room PATCH не перезаписывает новое состояние владельца старым снимком, если personalState не указан явно. Обычные room DTO, включая open/reopen и bind-scene-bundle, больше не отдают owner-only state участникам; административное чтение сохраняется. Личные заметки остаются привязаны к identity участника и не переходят новому владельцу комнаты.

Для notes read/versions/export, списка документов, download/presentation/content и generic room GET подготовленные данные отправляются только после актуальной authority-проверки. Документ повторно проверяется на tombstone и активную surface binding. Чтение объекта и построение экспорта идут вне DB fence; после ответа COMMIT failure не приводит к повторной записи headers или ложному denied-аудиту. PostgreSQL/HTTP-тесты ждут реальной блокировки parent-room перед handoff/revoke/tombstone/unlink, проверяют отсутствие данных и attachment headers при отказе. Удаление blob после подготовки подтверждает отсутствие внешнего I/O внутри транзакции.

Остаются отдельные activation gates для существующих self-hosted LiveKit JWT, source grants/eviction/rejoin, scene binding и других metadata/presence effects, а также архивирования долгоживущих комнат. Общий floor 2 этим срезом не активируется.

Workspace lint/typecheck/build прошли. Несколько полных пакетных запусков на исходном локальном PostgreSQL завершились timeout прежнего identity-контракта и каскадом ошибок после teardown; эти запуски зелёными не объявляются. Тот же образ PostgreSQL 16 с обычными настройками транзакций запущен отдельно на tmpfs, без изменения исходного контейнера: полный `pnpm test` с PostgreSQL/pinned rollback прошёл — API **858/858**, runtime **931/931**, remote-browser **39/39**, room-state **76/76**, shared-types **30/30**, tools **125/125**. Финальный полный local `pnpm test:e2e --workers=1` — **158/158**, без skip/retry (27 минут). Предшествующий browser-прогон был прерван пользователем и не считается завершённой проверкой. Временный контейнер удалён после проверки; проверки и таймауты не ослаблялись.

| Этап personal-state и приватных ответов | Результат |
|---|---|
| Проверенный и опубликованный SHA | `c1ddeb59cc6b4cc88f410547f88dc5977e4c07da` |
| [CI 37016971346](https://github.com/vrata-labs/platform/actions/runs/37016971346) | Success: пакетные тесты, полный E2E, M0.5 и pinned assets |
| [Docker Publish 37016971564](https://github.com/vrata-labs/platform/actions/runs/37016971564) | Success: immutable API, room-state и remote-browser images exact SHA |
| [Staging Deploy 37020948633](https://github.com/vrata-labs/platform/actions/runs/37020948633) | Success с первой попытки: **52/52 staging E2E**, **1/1 blocking Rutube**; successful SHA сохранён; rollback skipped |

[Артефакт staging gate](https://github.com/vrata-labs/platform/actions/runs/37020948633/artifacts/11234757275): текущая загрузка Hall/BlueOffice/ArtGallery, встреча с PDF/notes и cleanup прошли. После gate `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — HTTP 200. Общий identity floor остался 1; v2 owner/revoke races проверены в отдельных PostgreSQL/HTTP fixtures и не выдаются за активацию на общем staging. Retry/rollback этой публикации не потребовались.

### T01a-S2b-V: scene binding, presence и пригласительные действия

Подготовлен fresh Host-or-Owner fence для bind-scene-bundle, invite/waiting списков, revocation и approve/reject. Владелец personal room с ролью Member сохраняет управление; бывший Host не продолжает действие после передачи роли. Узкий scene setter не переписывает status/visibility из старого снимка, соблюдает immutable reference template/CAS и обновляет только URL и производный roomConfig URL. Callback не берёт дополнительные соединения пула и не выполняет внешнюю загрузку assets.

Manifest/presence ответы выпускаются после authority-проверки. Presence PUT публикует данные внутри fence с актуальной серверной ролью, ID и timestamp; удалённый участник не возвращается поздним body, а обычный role handoff не заставляет восстанавливать identity. Повтор invite revoke сохраняет первоначальные actor/time. Memory/PostgreSQL и реальные HTTP-тесты покрывают потерю роли/epoch, конкурентный disable/visibility, owner-Member, ожидание/повтор решения, immutable reference rejection, пул размером один и прогресс восьми клиентов с lifecycle write. Это не гарантия распределённого presence и не проверка пикового performance SLA.

Общий floor 2 не активируется. Остаются session expiry в других lifecycle/invite-creation путях, LiveKit source grants и снятие текущего показа, проверка повторного media-входа и политика длительно живущих комнат.

Локально прошли workspace lint/typecheck/build и полный `pnpm test` с настоящим PostgreSQL 16 на отдельном tmpfs и pinned rollback builds: API **861/861**, runtime **931/931**, remote-browser **39/39**, room-state **76/76**, shared-types **30/30**, tools **125/125**. Финальный полный local `pnpm test:e2e --workers=1` — **158/158**, без skip/retry, с первого запуска (25,7 минуты). Временный контейнер удалён после проверки; исходный локальный PostgreSQL и соседние сессии не менялись.

| Этап scene/presence/invitation metadata | Результат |
|---|---|
| Проверенный и опубликованный SHA | `747c21c2648f92068f9b7e924ee802b331be7750` |
| [CI 37046187648](https://github.com/vrata-labs/platform/actions/runs/37046187648) | Success: пакетные тесты, полный E2E, M0.5 и pinned assets |
| [Docker Publish 37046188664](https://github.com/vrata-labs/platform/actions/runs/37046188664) | Success: immutable API, room-state и remote-browser exact SHA |
| [Staging Deploy 37053365482](https://github.com/vrata-labs/platform/actions/runs/37053365482) | Success: **52/52 staging E2E**, **1/1 blocking Rutube**; successful SHA сохранён; rollback skipped |

Первая попытка [37049629955](https://github.com/vrata-labs/platform/actions/runs/37049629955) дала 51/52: strict LiveKit audio public-demo не выполнил двусторонний критерий за 45 секунд. Штатный rollback прошёл, `/health`, `demo-room` и control-plane после него отвечали 200. Причина audio-сбоя не объявляется установленной. Повтор полного gate того же SHA без изменения кода и таймаутов прошёл полностью.

[Артефакт успешного gate](https://github.com/vrata-labs/platform/actions/runs/37053365482/artifacts/11248629107): Hall/BlueOffice/ArtGallery loaded, private four-party meeting и cleanup завершены. Последующий public smoke `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — 200. Общий identity floor остался 1; фактические v2 fences проверены отдельными PostgreSQL/HTTP-тестами и не выдаются за активацию v2 на общем хосте.

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
