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

### T01a-S2b-V: expiry перед authority mutation и invite issuance

Room-session mutation actor теперь требует server-derived deadline; HTTP lifecycle и invite-creation используют один проверенный конструктор без копирования сроков из body. Проверка в reducer выполняется после ожидания parent-row lock; invite авторизация и createdAt используют один пост-read sample внедряемых часов. PostgreSQL invite denial больше не падает обычным Error/500 — результаты типизированы и согласованы с Memory. Поздняя expiry возвращает отдельный 401, включая приватный response fence; identity при этом не отзывается и может обновить сессию через свой proof без recovery.

Адресные проверки охватывают malformed/missing gateway deadlines, точную границу времени в Memory/PostgreSQL, очередь на parent lock с перемещением часов и действующий контрольный случай, admin без room-session expiry, seven stalled-body HTTP mutations с подставленным будущим сроком и приватный ответ после expiry. Команды используют актуальные revisions и подготовленные target states, поэтому expiry является реальной причиной отказа, а не маскируется прежним revision conflict. Отдельный stale-revision случай проверяет приоритет ошибок.

Общий floor 2 не активируется. До cutover остаются policy-row fence для in-flight legacy requests, корректная классификация уже истёкшего входного rs2, expiry перед будущим wiring RI2 mutation helpers и media source/отзыв текущего показа.

Полный реальный HTTP-сценарий также подтверждает именно PostgreSQL invite-denial после входной проверки: действующий Host ожидает parent-room lock, роль передаётся другому участнику в удерживающей транзакции, затем запрос получает **403 identity_forbidden**, не 500, и новое приглашение не сохраняется. Это отличается от отказа на входе запросу уже бывшего Host.

Локальная проверка: lint/typecheck/build, полный `pnpm test` с PostgreSQL 16 и pinned rollback builds — API **866/866**, runtime **931/931**, remote-browser **39/39**, room-state **76/76**, shared-types **30/30**, tools **125/125**. Финальный полный local `pnpm test:e2e --workers=1` — **158/158**, с первого запуска, без skip/retry (25,4 минуты). Изолированный PostgreSQL на tmpfs удалён после проверки; исходный контейнер и соседние сессии не менялись. Неблокирующее различие двух форм 401 закреплено в activation contract как задача до общего client retry-on-expiry.

| Этап mutation-time expiry | Результат |
|---|---|
| Проверенный и опубликованный SHA | `ef86045616cc789976ffe3736114eb08c33a45a8` |
| [CI 37074548526](https://github.com/vrata-labs/platform/actions/runs/37074548526) | Success: пакетные тесты, полный E2E, M0.5 и pinned assets |
| [Docker Publish 37074549321](https://github.com/vrata-labs/platform/actions/runs/37074549321) | Success: immutable API, room-state и remote-browser images exact SHA |
| [Staging Deploy 37076602433](https://github.com/vrata-labs/platform/actions/runs/37076602433) | Success с первого запуска: **52/52 staging E2E**, **1/1 blocking Rutube**; successful SHA сохранён; rollback skipped |

[Артефакт staging gate](https://github.com/vrata-labs/platform/actions/runs/37076602433/artifacts/11258127532): текущая загрузка Hall/BlueOffice/ArtGallery и сценарий private four-party meeting с cleanup прошли. Последующий public smoke `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — HTTP 200. Общий identity floor остался 1; реальная v2 expiry проверена в отдельной PostgreSQL/API схеме, не как публичная активация. Retry/rollback этой публикации не потребовались.

### T01a-S2b-V: bounded legacy write/release policy fence

Non-admin legacy callback теперь берёт parent-room lock, затем policy FOR SHARE и проверяет floor 1/no bindings перед эффектом. Raise использует ограниченный по времени EXCLUSIVE policy-table lock, чтобы новые читатели не продлевали очередь бесконечно. Runtime facade выдаёт только DB-only методы, сохраняет legacy waiting semantics, становится недействительным после callback и запрещает действия после release. Memory повторно проверяет policy/binding перед каждой операцией и отправкой ответа. Client error/idle-timeout не приводит к необработанному pg error; pool acquisition failure, распознаваемые lock/connection errors и uncertain COMMIT сопоставляются с retryable 503. Failed connection уничтожается, dead facade не отправляет данные; универсальная нормализация иных pre-COMMIT transport errors не заявляется.

Адресные проверки подтверждают оба порядка effect/raise с реальными pg_locks, отсутствие pool borrowing, scope lifetime, bound-room refusal при floor 1, Memory await gap, delayed legacy private-note body с cutover и binding, 503 по parent-lock timeout и работу после idle backend exit. Body-барьер ждёт существующий audit event после авторизации конкретного request ID, а не полагается на фиксированные 100 мс. Raise завершается до окончания body — транзакции не удерживаются во время ввода/загрузки. Anonymous bound-room refusal существовал на входе; добавлена защита in-flight release.

Manifest builder принимает тот же проверенный room snapshot: явный null не может при повторном чтении превратиться в новую private-комнату с раскрытием owner/assets. Совместимый v1 fallback presence для отсутствующей комнаты сохранён и отмечен отдельным scope-less гейтом. Release-аудит учитывает момент отправки: COMMIT failure после выдачи приватных данных не записывается как denied authority. Эти случаи покрыты прямыми регрессиями.

Неопределённый исход document publication сохраняет blob: неизвестная ошибка после начала COMMIT не доказывает rollback; administrative autocommit имеет тот же marker. Проверенный server rejection и pre-commit denial различаются. Причина сохраняется через HTTP mapping, ответ 503 учитывается как uncertain upload. Реальный HTTP-тест выполняет COMMIT строки, затем имитирует потерю подтверждения и проверяет наличие строки/файла; второй сценарий выполняет admin autocommit и сообщает query timeout. Orphan reconciliation остаётся отдельной задачей — автоматическое удаление при неизвестном результате недопустимо.

Срез ограничен уже scoped callbacks и ordinary manifest/room/presence ветками. Legacy document DELETE и personal create/open требуют следующего отдельного среза (внешняя cleanup/bootstrap последовательность); frame credentials/TTL, admin-seeded owner evidence и expiry/media gates также остаются. Общий staging floor 2 не активируется; v1 role/owner TOCTOU внутри floor 1 не объявляется устранённым.

Локально прошли lint/typecheck/build и полный `pnpm test` с изолированным PostgreSQL 16 и pinned rollback: API **881/881**, runtime **931/931**, remote-browser **39/39**, room-state **76/76**, shared-types **30/30**, tools **125/125**. Первый полный local E2E дал 157/158: прежний owner-handoff не дождался room-state connection за 5 секунд, затем отдельно прошёл без правок. Финальный полный `pnpm test:e2e --workers=1` на том же исполняемом дереве — **158/158**, без skip/retry (26,7 минуты). Проверки/таймауты не ослаблялись; временный PostgreSQL удалён, исходный контейнер и другие сессии не менялись.

| Этап bounded legacy policy fence | Результат |
|---|---|
| Проверенный и опубликованный SHA | `40e22f86d026220cbe26b976bcaac51073c68495` |
| [CI 37121442342](https://github.com/vrata-labs/platform/actions/runs/37121442342) | Success: пакетные тесты, полный E2E, M0.5 и pinned assets |
| [Docker Publish 37121442747](https://github.com/vrata-labs/platform/actions/runs/37121442747) | Success: immutable API, room-state и remote-browser exact SHA |
| [Staging Deploy 37124949357](https://github.com/vrata-labs/platform/actions/runs/37124949357) | Success: **52/52 staging E2E**, **1/1 blocking Rutube**; successful SHA сохранён; rollback skipped |

Первая попытка [37123417002](https://github.com/vrata-labs/platform/actions/runs/37123417002) дала 51/52: strict LiveKit audio public-demo не выполнил двусторонний критерий за 45 секунд. Штатный rollback прошёл, health отвечал 200. Причина сбоя не объявляется установленной. Повтор полного gate того же SHA без правок кода/таймаутов завершился успешно.

[Артефакт успешного gate](https://github.com/vrata-labs/platform/actions/runs/37124949357/artifacts/11274853982): текущие Hall/BlueOffice/ArtGallery loaded, private four-party meeting и cleanup прошли. После gate `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — HTTP 200. Общий identity minimum остался 1; реальные cutover/fence/неопределённый COMMIT проверены в отдельных схемах, не как активация общего v2.

### T01a-S2b-V: legacy DELETE intent и personal bootstrap/reopen

Все протоколы используют единый DELETE intent: tombstone под актуальным fence, затем media/blob cleanup без блокировок. При cleanup failure документ скрыт и допускает авторизованный повтор; stale hint больше не определяет retry/метрику transition. После cutover может завершиться intent, подтверждённый раньше, но новая legacy retry запрещена. Неопределённый commit не начинает cleanup.

Legacy personal creation/open защищены policy-row fence и проверкой текущего owner/type/tenant/binding перед ответом. Создание берёт rooms relation lock до policy, использует current-template lookup и INSERT на одном client, reopening после deterministic-ID collision через savepoint. API precheck, дававший ложный 409 concurrent same-owner requests, удалён. V2 bootstrap использует тот же порядок и single-client path — pool max 1 и два конкурентных bootstrap не требуют второго соединения.

Адресные проверки включают committed tombstone до RPC и отсутствие fence при cleanup (NOWAIT room/policy probes), hidden state после failure, concurrent retries, raise во время cleanup, старую retry после cutover и admin convergence. Personal tests покрывают duplicate storage/HTTP create с одной строкой/одним 201, relation order, queued raise, delayed body и подготовленный reopen reply. План не объявляется завершённым: admin seed, v2 reopen-owner race, virtual/frame/media и idempotent/orphan reconciliation остаются отдельными гейтами.

Гонки закреплены управляемыми сценариями: два первоначальных DELETE читают живой документ до fence, но учитывают один transition; два bootstrap ждут внутри INSERT после пустого поиска; второй HTTP owner lookup возвращает сохранённый пустой результат после завершения первого create. DELETE, ожидающий parent-room lock, после raise отказывается без tombstone, cleanup и изменения метрики. NOWAIT cleanup probes включаются только в одиночных сценариях. Ошибки fence преобразуются только около защищённых bootstrap-вызовов; обычные pool/template failures сохраняют request-failure accounting.

Финально прошли workspace lint/typecheck/build и полный `pnpm test` с PostgreSQL и pinned rollback: API **884/884**, runtime **931/931**, remote-browser **39/39**, room-state **76/76**, shared-types **30/30**, tools **125/125**. Полный финальный `pnpm test:e2e --workers=1` — **158/158**, без skips/retries (26,6 минуты).

Первый E2E запуск не передал PostgreSQL URL: 141 passed, 15 skipped, 2 fixture setup failures; это не принималось как итоговая проверка. Следующий полный запуск дал 157/158: owner-handoff не обновил client isOwner за 5 секунд после HTTP 200. Focused owner-handoff прошёл без правок сценария и таймаутов, затем полный финальный suite прошёл. Причина задержки не объявляется установленной; соседние процессы и контейнеры не изменялись.

| Этап DELETE/personal bootstrap | Результат |
|---|---|
| Проверенный и опубликованный SHA | `e97e9eba9aa653402494f8a5ef83acc6486423a3` |
| [CI 37156005963](https://github.com/vrata-labs/platform/actions/runs/37156005963) | Success: пакетные тесты, полный E2E, M0.5 и pinned assets |
| [Docker Publish 37156008261](https://github.com/vrata-labs/platform/actions/runs/37156008261) | Success: immutable API, room-state и remote-browser exact SHA |
| [Staging Deploy 37157990532](https://github.com/vrata-labs/platform/actions/runs/37157990532) | Success с первой попытки: **52/52 staging E2E**, **1/1 blocking Rutube**; successful SHA сохранён; rollback skipped |

[Артефакт успешного gate](https://github.com/vrata-labs/platform/actions/runs/37157990532/artifacts/11286872189) подтверждает Hall/BlueOffice/ArtGallery loaded на текущих browser pages, strict real-LiveKit four-party meeting и cleanup. После gate `/health`, `/rooms/demo-room`, `/control-plane`, `/api/templates` — HTTP 200. Rollout preflight подтвердил minimumIdentityProtocol 1 и отсутствие общего authority binding; общий v2 не активировался. Временный локальный PostgreSQL удалён после финальных проверок.

CI наблюдение дважды прерывалось сетевым unexpected EOF при обращении к GitHub API; возобновлено наблюдение тех же runs, сами workflows не перезапускались. Перед публикацией дождались завершения другого staging deployment, не отменяя его. Для этого SHA deploy/retry/rollback исключений не потребовалось.

### T02/T03: внешний SDK, bounded QuickJS Worker и personal reopen

Добавлен `@vrata/room-plugin-sdk@0.1.0`: versioned artifact, SHA-256 точных байтов, ESM import validation через Acorn, flat typed config, capability/event/request/response DTO, bounded data validation. Standalone welcome-status собран из SDK tarball вне workspace. Это завершает контракт T02; публичная выдача SDK/CLI и второй внешний sample в T06 ещё впереди.

QuickJS 0.32.0 release-sync исполняет lifecycle ESM в отдельном Worker с production CSP без browser globals и сети. VM serializer ограничивает данные до native copy; capabilities и rate limits независимо проверяются host. Handler/init 50 ms, supervisor 500 ms, trusted boot 3 s; heap 16 MiB, измеренный VM stack 32 KiB и WASM cap 48 MiB. Начальные 256 KiB привели к native stack failure в Chromium; 32 KiB проверены рекурсией, deep JSON и nested join. Heap probe 20 MiB с контрольным отключением только VM heap fence отличает heap limit от линейного WASM cap. DEBUG_SYNC handle checks не выдаются за acceptance production stack.

Четыре compiled-browser сценария покрывают CSP/WASM boot, token canaries/network, native regex/healthy companion, hostile serialization/jobs/memory/stack и измерения. Они зарегистрированы также для опубликованного staging. Архитектура и незакрытый real Android/Quest gate описаны в `docs/arch/2026-10-04-room-plugin-sandbox.md`. Desktop spike позволяет продолжить T04–T10, но не объявляет author uploads и auto-seat готовыми.

V2 personal reopen подписывает renewal синхронно после свежей owner/epoch/lifecycle/original-RI2-expiry проверки на одном fenced PostgreSQL client. Disabled/end — 403 без ошибочного recovery. RS2 expiry возвращает renewable 401 только после MAC/scope/participant/current-epoch проверки; Bearer и body token классифицируются одинаково. Повторная проверка после body wait исключает использование entry cache для expired/revoked diagnostics и XR requests. Полный auth/effect fence для telemetry, administrator owner seed и остальные media/virtual activation gates остаются отдельно; общий floor 2 не активируется.

Локально прошли workspace lint/typecheck/build/tests, затем полный API suite **905/905**, runtime **989/989**, SDK **39/39**, tools **125/125** и финальный полный E2E **162/162** (24,3 минуты), без skips/retries. Чистая API Docker-сборка проверила новый SDK-before-runtime порядок. Промежуточный full API обнаружил legacy remote-browser-frame 400 вместо ожидаемого 409; entry boundary восстановлен, неизменённый тест и полный suite прошли. Финальный E2E повторён после последних API и packaging правок.

Первоначальный SHA `be8f8b5` не развёртывался: [CI 37196612236](https://github.com/vrata-labs/platform/actions/runs/37196612236) обнаружил отсутствие SDK dist types при clean-checkout lint; [Docker Publish 37196613992](https://github.com/vrata-labs/platform/actions/runs/37196613992) собрал application images, но остановился на сетевом timeout YCR проверки dependency image. Workspace теперь использует source types, а `publishConfig` и `pnpm pack` публикуют declarations. Реальный tarball и внешний строгий ES2022-потребитель без DOM/Node ambient types проверены; отдельный чистый checkout прошёл frozen install/lint/typecheck до любого SDK build.

| Этап SDK/sandbox/reopen | Результат |
|---|---|
| Проверенный и опубликованный SHA | `c68f81704dae6bb8b909c49981df8c980180cd5f` |
| [CI 37201946188](https://github.com/vrata-labs/platform/actions/runs/37201946188) | Success: пакетные тесты, полный E2E, M0.5 и pinned assets |
| [Docker Publish 37201947969](https://github.com/vrata-labs/platform/actions/runs/37201947969) | Success: immutable application images и registry manifests exact SHA |
| [Staging Deploy 37204163084](https://github.com/vrata-labs/platform/actions/runs/37204163084) | Success с первой попытки: **56/56 staging E2E**, **1/1 blocking Rutube**; successful SHA сохранён; rollback skipped |

[Артефакт gate](https://github.com/vrata-labs/platform/actions/runs/37204163084/artifacts/11304593839) содержит четыре новых Worker/CSP sandbox проверки, stack/memory measurements, текущие Hall/BlueOffice/ArtGallery loaded, strict real-LiveKit four-party meeting и cleanup. Skipped/flaky/unexpected — 0. Public health, demo-room, control-plane, templates и `/plugin-sandbox-probe.html` после gate — HTTP 200. Running image tag подтверждён exact SHA; minimumIdentityProtocol остался 1. Временные локальные PostgreSQL и проверочные worktrees удалены; соседние процессы не менялись.

Проверку реального Android/Quest можно выполнять на [опубликованном diagnostic probe](https://158.160.10.234.sslip.io/plugin-sandbox-probe.html). Это оставшийся device gate T03; открытая загрузка/установка плагинов, bindings, room broker и auto-seat пока не поставлены. Следующие реализации T04–T10 должны использовать этот SDK/Worker, без встраивания конкретного sample в основной runtime.

### T04/T06: packages/bindings, private storage, внешний CLI и понятная device-диагностика

Добавлены одинаковые Memory/Postgres storage contracts: immutable room-scoped version/hash, квоты 10 live packages / 10 MiB / 2 enabled и 200 lifetime versions, CAS revision/generation, независимый config budget 16 KiB и bounded binding envelope. DB callbacks используют один parent-room fenced client; readonly reads не создают state rows. Upload reserve/publish/cleanup сохраняют ключи и intent до подтверждённого результата writer. Matching GET, elapsed time и abort не доказывают settlement неизвестного PUT. Старый API `81c14b6` проверен на новой схеме; FK не допускают удаление комнаты с plugin artifacts старым кодом.

Remote artifacts выделены в обязательный `ROOM_PLUGIN_BUCKET`, отличный от публичного bucket сцен/документов. Compose/MinIO bootstrap сохраняет public download для сцен и устанавливает anonymous none для plugin bucket. Реальный MinIO доказал signed byte-exact PUT/GET и unsigned 403; отрицательный контроль public bucket отказывает. Compiled operator verifier проверяет фактический deployed namespace в staging gate, не публикует пакет/binding и очищает только собственную UUID-фикстуру. Backend fingerprint фиксирует credential-free locator; ротация credentials разрешена, retargeting старых keys запрещён. Неизвестный writer сохраняет pending metadata.

Backup manifest v2 включает private objects/inventory/policy/checksums. Restore применяет anonymous none до private bytes и проверяет восстановленное содержимое; public scene storage остаётся отдельно. V1 backup до T04 поддержан только для подходящего пустого target plugin state после read-only preflight и locked recheck. Подготовка, dump и текущий plugin DDL восстанавливаются атомарно; неподдерживаемые формы dump отказывают до DDL. Bounded UTF-8 pg_dump profile различает plain/E/dollar/COPY, запрещает mode/transaction/program escapes и любой физический NUL. Реальные disposable Postgres/MinIO fixtures подтвердили v1/v2 restore, exact metadata/binding, private signed 200/anonymous 403, public scene 200, state-race refusal и сохранность data/catalog/index OIDs при SQL failure. Это не sandbox для произвольного операторского SQL.

SDK ships `vrata-room-plugin bundle/pack/validate`, pinned esbuild, canonical bounded project-root reads, single module identity при cycles и корректное import/require разрешение. Workspace source types/published declarations сохранены; раздельные runtime ESM/CommonJS graphs устраняют конфликт transformation cache в mixed Playwright discovery. Два standalone examples собраны вне workspace только из SDK tarball: welcome-status и auto-seat scaffold. Публичный archive адресуется версией и content SHA-256 через `/assets/plugin-sdk/releases.json`; проверяется соответствие свежему pnpm pack. Live author upload/broker/auto-seat остаются T05/T07–T10/T16.

Ручной probe больше не требует интерпретировать state failed: показывает русскую цель/ожидаемый исход, отдельный PASS/FAIL и фазу init/event/dispose. One-button run охватывает 37 фиксированных сценариев, concurrent companion ACKs и visible browser-trusted DURING input; post-run clicks не закрывают during-проверку и не меняют её timing. Whitelist JSON не содержит room credentials/private context. Trusted cold-path warmup выполняется в отдельном уничтожаемом realm внутри существующего prepare-budget 3 s до guest source; guest 50 ms/heap/stack/linear memory/watchdog не увеличены. Реальный Chromium after-profile дал 0/120 healthy/globals timeout; настоящий Quest report этим не заменяется.

Финально на Node **22.23.3** прошли workspace lint/typecheck/build/tests: API **977/977**, runtime **1012/1012**, SDK **64/64**, tools **251 passed / 2 optional skipped**. Оба optional real-backup сценария отдельно прошли 1/1 с disposable fixtures. Полный final `pnpm test:e2e --workers=1` — **167/167**, без skips/retries (**46,8 минуты**). Actionlint, Compose models, clean SDK discovery без dist, Docker SDK/verifier import и real private-storage proof прошли.

Промежуточные прогоны не принимались как финальная проверка: loader failure при mixed CJS/ESM, переиспользованный старый base server, startup/IO timeouts на Node26 под нагрузкой, общий лимит инструмента 1 h и отдельные owner-handoff/presence/reference timeouts. Harness теперь владеет тремя сервисами отдельно, использует process.execPath и private run logs, отказывает при занятом вспомогательном порте. Функциональный Meeting test сохраняет CSS 640×400, сцену/материалы, все восемь exact seat/root assertions и прежние 300/15 s бюджеты; software-rendering DPR 0.5 проверяет buffer 320×200. Сопоставимый контроль 257→158 s не объявляет изменение runtime/визуального benchmark. Соседние процессы и WSL не менялись; причины отдельных transient failures не объявлены установленными.

Перед финальной staging-публикацией T04/T06 первый [gate 37410180464](https://github.com/vrata-labs/platform/actions/runs/37410180464) на `599c6ab0f8391225d9651240b794f8f58fb35e9a` подтвердил private-storage proof: signed PUT/byte-exact GET, direct/external unsigned 403, отсутствие publication/binding и cleanup собственной комнаты. Browser gate дал 58/61: три complete-report проверки прервали продолжающийся 37-сценарный run по default expect timeout 5 s. В логе видно продвижение loop → heap/oversize, а не отказ VM. Штатный rollback вернул `c68f81704dae6bb8b909c49981df8c980180cd5f` и восстановил scene URLs/smoke.

Для этих трёх ожиданий завершения full-suite установлен bounded wait 45 s внутри прежнего test deadline 60 s. Старт, phase/code/verdict, DURING/hidden/capability и memory/CPU/watchdog assertions не изменены; это не увеличение guest budget. Final local E2E после правки — **167/167**, без skip/retry (**27,7 минуты**).

| Этап T04/T06/device probe | Результат |
|---|---|
| Проверенный и опубликованный SHA | `2380a14bd1d154a5fe3ad99d1a0572298b163eb7` |
| [CI 37416222195](https://github.com/vrata-labs/platform/actions/runs/37416222195) | Success: clean install, checks, package tests, full E2E, M0.5 и pinned assets |
| [Docker Publish 37416224736](https://github.com/vrata-labs/platform/actions/runs/37416224736) | Success: immutable images и registry manifests exact SHA |
| [Staging Deploy 37419271064](https://github.com/vrata-labs/platform/actions/runs/37419271064) | Success: private-storage proof, **61/61 staging E2E**, **1/1 blocking Rutube**, persisted successful SHA; rollback skipped |

[Артефакт gate](https://github.com/vrata-labs/platform/actions/runs/37419271064/artifacts/11393442100) подтверждает полный 37-case report/DURING/hidden проверки, публичный SDK archive exact SHA, текущие Hall/BlueOffice/ArtGallery loaded, strict real-LiveKit four-party meeting и cleanup. Skipped/flaky/unexpected — 0. Private probe подтвердил signed byte-exact GET и direct/external unsigned 403, отсутствие publication/binding и удаление только своей fixture room. Running image tag проверен; minimumIdentityProtocol остался 1.

После gate health, demo-room, control-plane, templates, [device probe](https://158.160.10.234.sslip.io/plugin-sandbox-probe.html) и [SDK releases](https://158.160.10.234.sslip.io/assets/plugin-sdk/releases.json) вернули HTTP 200. Самостоятельный CLI доступен в immutable SDK tarball `0.1.0/c301002fb1fdbd3eb1c4aad396adef4e0160d450051f1a3ee5e9ae84b66a7896/vrata-room-plugin-sdk-0.1.0.tgz`. Проверочные storage/backup projects удалены только после подтверждения принадлежности; native MinIO и последние PG fixtures остановлены. Устройство Quest по прежним кликам не объявляется прошедшим T03: теперь ручной результат может быть представлен понятным whitelist JSON.

### T03: недостающие ресурсные наблюдения на фиксированной diagnostic page

Дополнительный bounded resource-benchmark исполняет только платформенные fixed sources в том же production Worker/QuickJS: 100 последовательных init/event/dispose при живом companion, 60 секунд обычных событий и оба накопительных CPU-отказа на реальных часах. Handler 50 ms, supervisor 500 ms, heap/stack/linear-memory и опубликованные cumulative budgets не увеличиваются. Кампания не принимает author source и не открывает upload/binding API.

Результат отделяет PASS проверки от failed экземпляров бюджетных проб. Скрытие/отмена/недостаточное DURING наблюдение оставляют INCOMPLETE; реальные healthy/companion failures сохраняют FAIL. JSON ограничен явной проекцией, сохраняет partial data и не содержит произвольных guest output/credentials. Simultaneous linear buffers, init round-trip включая prepare, event/dispose и статистика записаны отдельно от browser memory API; недоступная память — null/NOT_MEASURED. Закрытие 104 собственных supervisors не заявляет физический GC.

Node22 runtime build и **1064/1064** unit tests прошли. Focused compiled-browser loop: **11/11**, включая production100cycles/real-second+minute budget stops, cancellation/hidden и прежние 37-case/CSP/network checks; full resource campaign занял около 1,8 минуты. Это локальная проверка, не опубликованный device gate. Real Android/Quest evidence и identity activation всё ещё необходимы до открытого author-code исполнения.

После финальных уточнений wall-time и negative DURING проверки runtime suite — **1070/1070**. Workspace lint/typecheck/build и полный пакетный test прошли с PostgreSQL: API **972 passed / 1 optional MinIO skipped**, SDK **64/64**, tools **251 passed / 2 optional real-backup skipped**. Storage/backup реализация здесь не менялась; opt-in live fixtures этого запуска не подменяются mock результатом.

Полный `pnpm test:e2e --workers=1` после первоначальных уточнений на Node **22.23.3** — **170/170**, без skipped/retries (**35,4 минуты**). Ресурсная диагностика сохранила исходные sandbox budgets, 100 циклов и оба реальных cumulative stops. Synthetic DURING не засчитывается, отмена закрывает свои экземпляры, hidden report остаётся неполным.

Промежуточные полные прогоны не принимались: PDF-state/room-state disconnect, reference startup и WebGL context loss. Повтор в отдельном Linux browser image того же Playwright **1.58.2**, Node22 и всех прежних assertions также дал timeout identity-сценариев и whiteboard sync refusal; это не замена зелёному полному local gate. Причина этих отказов не объявляется установленной или исправленной. В shared demo helper добавлен bounded allowlisted capture PDF-команд с server-result correlation и transport/message-error категориями. URL/tokens/raw frames/произвольные ошибки не сохраняются, own observers удаляются; действия и timeout-значения сохранены. В отдельном focused capture подтверждены Create/Select/Next2/Next3 accepted с revisions 0→3 и реальные пиксели.

Срез сохраняет исходный `companionFailure` также при асинхронном отказе между ping-ами: остановленный вследствие этого primary не получает выдуманную собственную ошибку. После этой правки runtime suite — **1082/1082**, полный local E2E — **170/170**, без skipped/retries (**27,4 минуты**, штатный режим без дополнительного tracing). Trace-повтор до этого дал video-playback failure и остановил serial cases; он не считается итоговой проверкой. Порогов, числа действий и ожиданий сценариев не меняли.

Окончательно уже зарегистрированный native fault сохраняется до cancel/hidden/termination, включая primary во время memory checkpoint. Ожидаемые budget failures и собственный instance_closed не становятся ложной ошибкой кампании. FAIL в сводке всегда просит сохранить JSON, даже при неполном DURING наблюдении. Итог: **1094/1094 runtime tests**, **170/170 full local E2E**, без skips/retries (**28,9 минуты**, Node22 штатный режим). Реальное устройство этим не аттестуется.

| Этап ресурсной диагностики T03 | Результат |
|---|---|
| Проверенный и опубликованный SHA | `9506de30b7f379e086c5db243dbbb398883693ae` |
| [CI 37493548436](https://github.com/vrata-labs/platform/actions/runs/37493548436) | Success: clean checks, package tests с PostgreSQL и pinned rollback, полный E2E, M0.5 и locked assets |
| [Docker Publish 37493548177](https://github.com/vrata-labs/platform/actions/runs/37493548177) | Success: immutable application images exact SHA |
| [Staging Deploy 37498466477](https://github.com/vrata-labs/platform/actions/runs/37498466477) | Success с первой попытки: private-storage proof, **64/64 staging E2E**, successful SHA сохранён; rollback skipped |

[Артефакт staging gate](https://github.com/vrata-labs/platform/actions/runs/37498466477/artifacts/11430677459) подтверждает resource PASS, 100/100 dual-instance cycles, 104 created/closed и active=0, healthy workload 60 308,5 ms, оба expected cumulative codes на EVENT и trusted DURING input. Companion: 547 ACK, максимум 1,5 ms; frame gap 19,1 ms, input delay 0,7 ms. Simultaneous linear buffers — 16+16 MiB, browser memory API — NOT_MEASURED. Это наблюдения browser runner, не физический Android/Quest или GC acceptance.

Текущие Hall/BlueOffice/ArtGallery достигли loaded с полными ожидаемыми asset bytes. Strict real-LiveKit four-party scenario/cleanup прошёл; четыре PDF-команды accepted, revisions 0→3. Skipped/flaky/unexpected — 0. Non-blocking Rutube canary — **1/1**; blocking Rutube для этого impact scope не запускался. Private signed/read-exact и direct/external unsigned 403 proof, отсутствие package publication и собственный cleanup подтверждены. Running image tag exact SHA, minimumIdentityProtocol 1 и identityAuthorityBound=false проверены; глобальная активация v2 не выполнялась.

После gate health/demo-room/control-plane/templates/device-probe вернули HTTP 200. [Публичная диагностика](https://158.160.10.234.sslip.io/plugin-sandbox-probe.html) содержит новый ресурсный прогон и оба downloadable report scopes. Собственный локальный PostgreSQL удалён после проверки ID/labels; disposable browser containers завершились, проверочные порты свободны. CI watch прерывался только лимитом локального ожидания; продолжено наблюдение того же успешного run без повторного CI/deploy.

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
