# T16: решения и причинные ограничения

Основание: внешний план `2026-09-25-working-meeting-and-room-plugins.md`, §0/T16/T17/§8.
Продолжение нумерации основного журнала после D-047; исторические записи не изменяются.
[Матрица T16](../validation/2026-10-31-t16-regression-matrix.md) · [Контракт проверок](../validation/2026-10-31-t16-regression.json).

## D-048 — 2026-10-31 — Отдельный T16-контракт без исключений предыдущего среза
- T15 JSON относится к уже принятому срезу и содержит узкое исключение. Для T16 используется отдельный контракт: 13 required=true, scope=[.], final-tree review/full local/exact-SHA publication обязательны.
- Основание: внешний план §0/T16, D-042–D-047 и исходники на b7ef73e. Успехи T15 не закрывают T16; внешний план до staging-приёмки не меняется, T17 открыт.

## D-049 — 2026-10-31 — Дополнять shared demo, не повторять sandbox/storage
- Normal onboarding, внешний SDK/author UI, PG barriers и быстрый sandbox уже существуют отдельно. Недостающая связь — общий public demo и exact server no-ghost proof.
- Используются прежний shared demo, passive existing-socket capture и reusable auto-seat local/X; protocol race не требует дополнительных 3D. Guest403 и owner exception сохраняются, pose ownership не меняется. Heavy cases остаются X, не G.

## D-050 — 2026-10-31 — Принимать проверяемые exact-SHA CI artifacts G/X
- Обычные gated/Extended workflows сохраняют Playwright artifacts; обязательные evidence включают run/attempt, точный candidate SHA, все mandatory cases без skips и before/after accepted/images.
- Второй дублирующий локальный G/X не обязателен при применимом CI proof. Дополнительный запуск — только на том же опубликованном commit под арендой. Это не исключение из full local.

## D-051 — 2026-10-31 — Общие observers без новой identity/API
- Passive CDP наблюдает только существующий authenticated socket; bounded participants/occupancy/correlated commands, media hash вместо содержимого. Новая observer identity изменила бы проверяемый состав участников.
- **Заменено D-056:** прежнее условие «closed либо denial» недостаточно. Действующий OLD witness требует реальный sent и correlated permission denial на pre-demotion scope/generation, затем fresh ordered media barrier.
- Hooks/CDP/DTO очищаются независимо; raw frames/URL/token/config/source не публикуются.

## D-052 — 2026-10-31 — Реальные permissions и явное approval нового hash
- Guest не имеет document.view/download: сохраняется штатный403, полноценный PDF render проверяется у разрешённых Host/Member. Роль ради теста не повышается.
- Новый artifact hash требует явного capability approval; допустимое частичное approval не запрещается. UI grant/revoke/transfer дополняют PG/security; former Host использует первоначальный Bearer при текущей authority.

## D-053 — 2026-10-31 — Разделить одновременную рассадку и deterministic busy race
- Четыре случайных offsets не гарантируют busy. Отдельные реальные WS contenders претендуют на одно место, требуют one-winner/busy/correlated release и выходят до exact-set проверки.
- **Post-ready readiness barrier заменён D-078** на четыре actionable onboarding формы до admission. Управляемый pending replay остаётся отдельным case по D-080; его release обязан быть раньше3000ms, иначе это не disable proof.

## D-054 — 2026-10-31 — Focused Node tests используют package autostart fence
- Прямой import room-state entry point без VRATA_DISABLE_AUTOSTART=1 оставляет сервер после assertions. Focused-unit использует тот же fence, что `apps/room-state/package.json:test`, без изменения runtime lifecycle или deadlines.
- Прерванный процесс не означает успешный набор; нужны terminal receipts всех обязательных tests.

## D-055 — 2026-10-31 — Результат до исправления witness не подтверждает исправленное дерево
- Browser запуск на b998bc5 прерван до окончательных assertions; его частичные успехи/ошибки не являются итоговой приёмкой.
- Каждый новый результат привязан к проверяемому дереву; interrupted/failed не заменяются последующим PASS. Independent owned cleanup обязателен даже при остановке проверки.

## D-056 — 2026-10-31 — Реальное действие OLD socket и fresh media barrier
- Surface create без probeOnly:false был лишь permission probe; cached media hash другого клиента не доказывал отсутствие эффекта.
- OLD command обязан быть sent с correlated access_denied/missing-permission на том же pre-demotion scope/generation. Затем тот же socket отправляет безвредный participant_update с уникальным clientTimeMs; reader должен увидеть marker в новом server snapshot и неизменный media hash.
- Marker не меняет pose/роль/права и не сохраняется в DTO. Close/new connection инвалидируют snapshot; reload/reconnect ждут новую generation. Counters и OLD overlap не заменяют этот proof.

## D-057 — 2026-10-31 — No-anchor использует собственный non-reference template
- Personal-workspace-basic deprecated, а reference scene override запрещён. Fixture создаёт свой template/version/hash только в проверенной disposable schema; inline scene передаётся штатному POST room.
- Перед teardown template скрывается; shared catalog/GLB/policy не меняются. Actual PG/API create201 проверяет допустимость fixture; browser zero-claim/manual refusal проверяется отдельно. Case остаётся local/C.

## D-058 — 2026-10-31 — Отменённая посадка проверяется до empty snapshot
- Final-only replay мог скрыть краткую ошибочную посадку. Сначала actual occupied/accepted отменённой попытки, delivery counters и два RAF, затем current+pending=null/desktop/unchanged standing root. Только после этого original-order empty/release и fresh exact authority.
- SeatingController mutation control нарушает intermediate standing при правильном final standing. Release<3000 и pose ownership сохраняются.

## D-059 — 2026-10-31 — Независимая очистка сохраняет primary и cleanup errors
- Неуспешный enter закрывает уже созданный, но не возвращённый context. cleanupAll/withCleanup независимо закрывают observers/contexts/author/room и сохраняют все ошибки в AggregateError с primary/cause.
- Owned actor всегда пытается удалить room; pending entries дожидаются завершения после закрытия contexts. Helper failure-path tests покрывают entry/close/actor/observer failures; cleanup error не становится PASS.

## D-060 — 2026-10-31 — CI guard ограничивает jobs независимо
- Граница core section не распознавала цифру в job ID e2e; валидный e2e скрывал повреждённый core. Исправлены только символы job ID в guard, workflow не меняется.
- Прежние service/env/health/Node assertions сохранены; шесть изолированных controls core/e2e × env/image/Node отвергаются реальным positive callback при неизменном другом job. Старый boundary эти controls не проходит.

## D-061 — 2026-10-31 — Scene/connection entry не равен plugin startup
- Отсчёт15s accepted до onboarding/scene включал заведомо предшествующие стадии.
- **Заменено D-080:** одного переноса сразу после entry недостаточно. Отдельный startup60000 ждёт actual outgoing claim, и только claim начинает response15000. Entry20000/arrival5000 подтверждаются сохранённым page-clock pre-send фактом, не поздним snapshot.

## D-062 — 2026-10-31 — Accepted status проверяется до следующего клиента
- После загрузки третьего клиента поздняя VM может показывать отказ при уже used grant/сохранённой seat. Actual scaffold/SeatAdapter воспроизводят это различие; текст новой VM не является результатом первой заявки.
- CurrentSeat/occupancy/accepted status/grant и correlated claim/result проверяются сразу после входа Member, до refusing entrant. Все opt-out/manual veto и независимый cleanup сохраняются; момент перезапуска исходного browser этим не устанавливается.

## D-063 — 2026-10-31 — Shared demo использует существующий functional frame budget
- Context получает существующий100ms RAF budget и passive performance observation до страниц. Viewport/DPR/drawing buffer, сцена, PDF/audio, права и sandbox/product deadlines не меняются.
- Основание: functional-frame-budget.ts и соседние multi-client suites. Frame starvation как причина старого host-unavailable остаётся гипотезой: исходный trace не доказывает единственную причину. Budget проверяется на первой странице, reload и новой странице; это не device/performance acceptance.

## D-064 — 2026-10-31 — Stale CAS требует допустимый PUT, не read DTO
- На a188d94 stale probe получал400 до CAS: read DTO содержит запрещённые bindingId/pluginId/generation/bindingRevision. Это штатный parser contract, не дефект CAS.
- staleBindingUpdate явно проецирует допустимые поля; expectedRevision1,409 и unchanged-library hash обязательны. Actual parser/storage control достигает CAS, отдельные read-only field mutations отвергаются. Parser/permissions не меняются.

## D-065 — 2026-10-31 — Конечный release не устанавливает причину отмены
- Retire и lost-answer3000 оба отменяют pending; HTTP completion не является временем применения manifest. Из одного release нельзя вывести причину или приписать её CPU/setup/polling.
- Bounded passive timing хранит claim/accept/CAS/runtime/release phases и status/revision/enabled count, без URL/credentials/config/source. Release3200 control сохраняет строгий отказ; для причинности нужны settlement и accepted revision, дополненные D-081.

## D-066 — 2026-10-31 — Skipped/interrupted PG tests не закрывают обязательный набор
- HTTP/storage запуск без PG пропустил PG-проверку; повтор с PG прерван до terminal результата. Отдельные успешные subtests не подтверждают весь набор.
- Нужен полный завершённый PG-backed результат; при прерывании очищается только доказанно owned fixture schema. Чужие схемы/контейнеры не используются для уборки.

## D-067 — 2026-10-31 — Persistent socket init требует Page.enable
- Actual transformed helper в Chromium без Page.enable не устанавливал hook ни на navigation, ни на reload. Включение Page domain той же CDP session до регистрации init script устраняет это; script/parser/CAS/permissions не меняются.
- Actual-helper control закрепляет enable→register и remove/detach/cleanup; OLD denial/fresh media assertions сохраняются.

## D-068 — 2026-10-31 — Удерживать voluntary OLD close, не полномочия
- main.ts:applyAccessDebug вызывает roomStateClient.close при смене роли; сохранённая ссылка сама по себе не сохраняет открытый транспорт. OLD-closed не доказывает denied реальную команду.
- Test-only hold откладывает только client close выбранного OLD socket. Runtime reconnect/server close/fresh API authority/expiry не подавляются; новых sockets hold не создаёт. Denial привязан к pre-demotion scope/generation, release восстанавливает close в finally.

## D-069 — 2026-10-31 — Closed без history не определяет arrival причину
- На c0837de все четыре VM были running/ready/online, grant closed/candidates0/claims[]. Это не busy/rejected/release timeout: claim не начинался. Node barrier timing нельзя вычитать из page-clock firstReady.
- Нужны bounded monotonic переходы и room.ready delivery facts, а не неподтверждённый product timing fix. Один успешный поздний run не устанавливает причину этого неполного trace.

## D-070 — 2026-10-31 — Причина closed сохраняется независимо от final state
- Identity-free diagnostics ограничены восемью grant transitions/ready deliveries, содержат monotonic время и причины. Условия переходов/порядок вызовов сохранены, без новых таймеров/API/планирования.
- Entry20000/window5000/claim3000 и initial60000 неизменны. Наблюдательность не является исправлением поведения и не заменяет browser elapsed proof.

## D-071 — 2026-10-31 — Delivery observer устанавливается до claim
- На80c24aa setup/read/hook работа заняла более2s до disable, release3339.3ms правильно отклонён. Близкий requestfinished не доказывает момент принятия revision.
- Passive hook устанавливается до navigation; pending/current читаются одним снимком, а pre-send proof далее сохраняется по D-079. Не меняются delivery/PUT/refresh/deadlines; intermediate actual delivery/two-RAF/pose остаётся обязательным.

## D-072 — 2026-10-31 — Успешный initial не объясняет прежний closed
- Traces80c24aa/8349419 прошли initial armed/open/used и correlated claims, но release3339.3/3004.5ms оба нарушили<3000. Сокращение тестовой работы до disable само по себе не исправило witness.
- Это не воспроизведение c0837de. Причину lost-answer/retire надо различать явно; совпадение elapsed с3000 не устанавливает callback-причину. Управляемые actual components дополняют, но не заменяют реальный browser.

## D-073 — 2026-10-31 — Управлять веткой pending-disable, не сроками продукта
- Actual Controller/Broker/SeatAdapter/KernelClient/QuickJS tests различают dispatch0/consumption800/completion1800. Empty manifest1200 даёт retired1200; manifest3100 проигрывает lost-answer3000. Hint/Host mutation/HTTP completion не равны runtime accepted revision.
- Pending CAS запускается непосредственно на real correlated accepted с заранее прочитанной revision; без GET/UI/poll в3000ms окне и без подмены ответов. Settlement reason/time bounded и не содержит identity.
- Прежний startup discovery hold заменён D-080; CAS-ordering уточнён D-079. Activate/retire/stale-revision mutation controls сохраняются. Fake clock не является browser elapsed proof или заменой watchdog tests.

## D-074 — 2026-10-31 — Lost-answer отличается от отказа без claim
- На9e8519f initial claim завершился lost-answer33637.4 и window-expired34322.8; другая поздняя instance получила arrivalAllowed=false. Это не trace c0837de с claims[]. Поздний accepted не оживляет grant и не даёт второй claim, что закреплено actual-component control.
- Ready promise failure не означает время начала handler, а новый running VM не доказывает здоровье прежней instance. Node/CDP/page clocks не смешиваются; физическая причина задержки из этого trace не установлена.

## D-075 — 2026-10-31 — Native receive не равен app delivery
- Playwright1.58.2 connectToServer оставляет WebSocketRoute в постоянном native→binding→Node→mock proxy, не native passthrough. CDP видит upstream endpoint, не callback RoomStateClient.
- Passive page-clock observer различает outgoing/native send/native receive/mock dispatch/app callback/return/release с current generation/attempt; adapter отмечает requested/answer/settlement непосредственно в компоненте. Actual injected mock control native400/app3500 закрепляет различие, без изменения bytes/delegation или deadlines.

## D-076 — 2026-10-31 — Normal initial transport должен оставаться нативным
- На8626b37 proxy crossings добавляли1.34–2.36s при callback<1ms и current correlation. Это доказанный дефект test setup, не единственная причина всех прежних failures; отдельный ready failure не воспроизводит D-074 lost-answer.
- Initial WS не маршрутизируется. Промежуточный post-ready HTTP barrier **заменён D-078**: после admission нормальные discovery/startup тоже не удерживаются. Managed pending replay и обычный author UI lifecycle остаются отдельными.

## D-077 — 2026-10-31 — Entry expiry не является claim-response timeout
- На2862254 native gaps0–0.1ms и три actual correlated accepts подтвердили устранение proxy crossings. Четвёртый firstReady18497.7→entry-expired39528.2→activate39582.2 не сделал claim: entry20000 истёк, claim3000 не начинался.
- Это подтверждает expiry только данного run, не c0837de. Discovery hold, artifact/startup и worker/renderer scheduling старый trace не разделял; startupTiming не является всем этим интервалом. D-078 устраняет post-ready gate, не продлевая entry.

## D-078 — 2026-10-31 — Синхронизировать формы до admission
- Четыре заполненные actionable normal onboarding формы ждут перед настоящими UI clicks. После release admission/scene/native WS/discovery/SDK startup не удерживаются. Admission response wait начинается перед click.
- firstReady запускает entry20000. Actual-component control отличает post-ready discovery hold20001 (expiry/claim0) от ожидания25000 до admission/readiness (полный budget/accepted).
- Отдельно проверяются trusted clicks/admissions/correlated claims/четыре distinct seats/exact authority. Passive page-clock discovery/worker/ready phases не раскрывают URLs/source/action IDs; handler-generated request не объявляется точным handler start/completion.

## D-079 — 2026-10-31 — Pending refresh следует настоящему Host CAS
- Enabled runtime read, начавшийся до завершения disable CAS, может занять poll slot и привести к lost-answer вместо retirement. Только managed pending refresh продолжается после actual CAS200; HTTP body/revision штатные, без fulfillment/kick.
- Hook до entry сохраняет actual pending/standing непосредственно перед неизменённым send. Node/page round trip перед upstream claim не нужен; поздний pending не исправляет отсутствующий pre-send факт.
- Initial normal clients полностью без routing. Ровно один claim/release<3000 и intermediate occupied+accepted→2RAF standing/pending-null/unchanged pose до empty/release обязательны; это не обещание arbitrary disable propagation<3000 при любой фазе polling.

## D-080 — 2026-10-31 — Разделить entry, startup и ответ claim
- enterPluginRoom подтверждает scene+connection, не discovery/artifact/Worker prepare/init. Pending retirement — отдельный export для одинаковых local/X wrappers; external build/ordinary Host CAS общие, Host renderer закрыт, один3D pending entrant. Initial four-client race/lifecycle сохранён отдельно.
- Normal startup без discovery hold bounded60000 после entry; response15000 начинается при actual outgoing claim. Saved page-clock pre-send readiness/correlation/online, activation≤entry20000/claim<arrival5000 обязательны. Роли/права/sandbox/pose/deadlines неизменны.
- На504e4fa separate pending1/1 и весь auto-seat spec4/4 завершены PASS без skips/retries. Это не общий focused/full, не объяснение старых failures и не замена дополнительных причинных assertions D-081–D-082.

## D-081 — 2026-10-31 — Retired требует sticky no-failure proof
- failEntry тоже вызывает SeatAdapter.retire. Последующий настоящий empty manifest удаляет failed entry и очищает lastFailure, поэтому retired/failed0/revision disabled/release<3000 допускают VM-failure cancellation до disable.
- Fresh single-binding pending witness требует lastInstanceFailure=null и exact runtime revision из обычного Host CAS; sticky поле не сбрасывается empty manifest. Ready failure после уже выполненного retire может отражать прекращённый lifecycle, поэтому один final failed-ready сам по себе не назначает причину отмены.
- Actual-helper/component negative control отвергает ready failure→реальный failEntry/retire→cancel→empty refresh, сохраняя retired, оба elapsed fences и все intermediate assertions. Продукт не меняется.

## D-082 — 2026-10-31 — Late zero effects проверяются после disabled discovery
- Scene+connection и свежий room_state приходят независимо от HTTP plugin discovery. Workers0/standing/authority допускают requests.plugin0 и не доказывают disabled binding.
- До zero-effects assertions нужен настоящий runtime HTTP200 с exact CAS revision/empty bindings и принятая runtime state=empty/revision/instances0/running0/failed0. Затем workers0/wasm0/claims0/current+pending=null и exact single-participant authoritative empty occupancy, лишь затем context close.
- Actual-helper positive и negative controls различают завершённую discovery, незавершённую discovery и непринятую revision. Без sleep/увеличения сроков; independent cleanup сохраняется. Final focused/package/full и exact-SHA DoD остаются обязательными.

## D-083 — 2026-11-02 — Functional RAF оставляет паузу после завершения callback batch
- В functional-frame-budget.ts устаревший RAF timestamp и повторный requestAnimationFrame внутри callback могли немедленно поставить следующий native frame, не оставив предусмотренные100ms после тяжёлого рендеринга. Actual-helper regression воспроизводит dispatch900/callback1200ms с RAF timestamp100: прежняя реализация оставляет0ms паузы.
- Планирование следующего native frame откладывается до конца batch;100ms отсчитываются от performance.now() после callback completion. Нативный timestamp, все callbacks и cancel semantics сохраняются; сцена, четыре участника, viewport/DPR, transport, роли, sandbox/lease/claim deadlines и assertions не меняются.
- Это исправление подтверждённого дефекта тестовой оснастки, не доказательство единственной причины host-unavailable в public demo. Полный прогон258PASS/1FAIL и изолированный повтор0PASS/1FAIL остаются FAILED; отдельный диагностический PASS с наблюдением методов не является приёмкой. Final-tree review/focused/package/full и exact-SHA gates по-прежнему обязательны.

## D-084 — 2026-11-02 — Не отправлять неизменившуюся рассадку в VM
- Presence обновляет комнатный снимок независимо от изменения рассадки. Coalescing100ms без сравнения порождал новые seating.snapshot даже для init-only обработчика; при задержке доставки результата VM считалась занятой и завершалась по истечении lease.
- Контроллер сравнивает весь сериализованный SDK snapshot, включая arrivalAllowed, только в пределах текущего экземпляра. room.ready доставляется каждой новой VM; изменённые снимки и запрет эффектов просроченного/скрытого/старого экземпляра сохраняются. Lease, тайм-ауты и бюджет запусков не меняются.
- Коррелированный отказ claim требует одного post-result события даже при неизменной занятости: auto-seat может перейти к следующему месту. Force сохраняется при coalescing и очищается после доставки либо stop; accepted/release/presence используют обычный путь.
- Проверка Controller+KernelClient+QuickJS различает три лишних busy-kill до изменения и тот же незанятый экземпляр после него; изменённые события по-прежнему завершаются при expiry, старые SDK эффекты запрещены, четвёртый запуск недоступен. Это компонентное основание, не приёмка public demo: новый браузерный отказ до enable требует отдельного исправления захвата кадра.

## D-085 — 2026-11-02 — Получать диагностические пиксели после GPU fence
- Исходный public demo остановился до enable плагина; синхронный captureCanvasDiagnostics занимал до15051ms. Уменьшение итогового изображения до320×180 и includeImage=false не устраняли ожидание GPU при drawImage исходного WebGL canvas.
- Выбран WebGL2: совместимый по alpha MSAA resolve, отдельный downscale, readPixels в ограниченный PBO и getBufferSubData только после сигнала fence. Измерение на программном WebGL2 различило блокирующие drawImage/createImageBitmap/toBlob и короткий enqueue PBO; это основание выбора API, не доказательство приёмки исходной сцены.
- Все затронутые GL bindings, pack layout и scissor восстанавливаются до первого await. После ожидания сохраняется уже текущее состояние рендерера; context loss, resize, failed fence и ограниченный срок ожидания дают null и освобождают ресурсы, без синхронного fallback или вымышленных пикселей. JPEG при необходимости строится только из готовых малых CPU-пикселей.
- Совместное ожидание кадра не объединяет HTTP reports и notes. После await повторно проверяется сессия; participantId читается вместе с актуальным токеном. Смена сцены требует нового снимка, а не старых пикселей с новым названием. Права, lease, watchdog, бюджет запусков и исходные browser assertions не меняются.
- Регрессии покрывают pixel orientation/alpha, MSAA format и bounded PBO, восстановление GL state между кадрами, ошибку/отмену и освобождение ресурсов, concurrent notes/HTTP и late identity. Итоговый browser/full/exact-SHA gate остаётся обязательным: остаточная задержка рендеринга этим выбором не объявляется устранённой.

## D-086 — 2026-11-02 — Продление lease не требует перезапуска незанятой VM
- Lease ограничен monotonic временем начала HTTP-запроса плюс5000ms и захваченным token deadline; server-issued wall clock не сравнивается с page clock. Discovery запускает startEntry без await, поэтому ожидание готовности VM не удерживает HTTP renewal. Expiry запрещает эффекты синхронно; busy/loading экземпляр завершается, а idle экземпляр может продолжить только после свежей принятой server authority. Старые permits и отозванная generation не восстанавливаются.
- Actual Controller/Broker/SeatAdapter/KernelClient/QuickJS подтверждают D-084: три expiry при неизменных снимках сохраняют один idle экземпляр; изменённые снимки с удержанным результатом приводят к трём завершениям и запрету четвёртого запуска. Удаление только dedupe в отдельной копии возвращает три избыточных события, три завершения и host-unavailable. Correlated busy, arrival expiry, hidden state и новая generation проверены отдельно.
- Окно600000ms и максимум3 попытки не меняются. Попытка расходуется в начале startEntry, до artifact/start; обычный refresh бюджет не сбрасывает. Исправление устраняет лишнюю работу, а не разрешает просроченные эффекты. Это не ретроспективное объяснение старого отказа Member.

## D-087 — 2026-11-02 — Успешный public demo не закрывает отказ opaque readback
- На D-084/D-085 обычный shared public demo завершён1/1 PASS за628.699s, без retries/skips и без дополнительного вмешательства в timing/authority. Runtime build/typecheck и1555 runtime tests,34 helper/routing tests и35 PG-backed author/socket authority tests прошли. Это узкая проверка, не итоговый focused/package/full или exact-SHA приёмка.
- Новый canvas-набор завершён3PASS/1FAIL: opaque alpha=false вернул null вместо пикселей. Отдельный повтор с одним worker снова дал этот отказ; соседний transparent case прошёл. В диагностическом варианте того же теста перед возвратом null подтверждены isContextLost=true, drawing buffer0×0 и CONTEXT_LOST_WEBGL. Самостоятельные точные вызовы reader вне test runner прошли; источник потери контекста пока не установлен.
- Возврат null при потере контекста соответствует защитному контракту reader, но не подтверждает корректность opaque capture на исправном контексте в этом сценарии. Менять assertions, разрешения, GPU-настройки или сроки по этому наблюдению нельзя. Общий срез остаётся неготовым к коммиту; исходные отказы сохраняются, новая правка reader без причинного доказательства не выбирается.
- Новые component/routing tests входят в runtime/root test globs; canvas spec входит в полный local и ровно один CI shard. Это client-only проверка compiled reader, не проверка удалённого сервера. Доставленный runtime по-прежнему требует обычных G/X flows на точном commit; локальный синтетический canvas нельзя выдавать за staging-подтверждение.

## D-088 — 2026-11-02 — Не считать непостоянную потерю WebGL доказанным дефектом reader
- Chromium145/ANGLE SwiftShader теряет opaque WebGL2 context после исправного рендера: до enqueue isContextLost=false и GL_NO_ERROR, затем приходит webglcontextlost, drawing buffer становится0×0 и возникает CONTEXT_LOST_WEBGL. Отдельный случай потери воспроизведён вообще без вызова reader; исчерпание GPU-ресурсов reader этим не подтверждено. Стабильная причина потери пока не установлена.
- Явный ANGLE/SwiftShader меняет также compositor: при том же GL renderer исходный профиль использует software compositing, явный — GPU compositing. Неизменённые четыре canvas-теста прошли на явном профиле, но последующая проверка прошла и на исходном, и при обратном отключении GPU compositing. Поэтому профиль не принимается как доказанное исправление и в настройки проекта не переносится.
- Контракт различает ненулевые реальные пиксели исправного opaque/transparent canvas и null при настоящей потере контекста. Полный неизменённый canvas spec завершён4/4 PASS без новых flags; отдельная проверка настоящего main→runtime-diagnostics→scene-debug→reader→HTTP на PostgreSQL16.15 прошла1/1: здоровый снимок совпал с независимым drawImage по среднему цвету в пределах2, а после явного WEBGL_lose_context сохранён null. Эти результаты не отменяют первоначальные отказы и не доказывают устранение непостоянной потери.
- Код reader и production runtime не меняются без причинного основания. Изолированные проверки не заменяют постоянную регрессию, fresh review/focused/package/full и exact-SHA приёмку; общий срез остаётся NOT_READY.

## D-089 — 2026-11-02 — Fence не подтверждает успешное выделение и чтение PBO
- WebGL сообщает об ошибке bufferData/readPixels/getBufferSubData через GL error flags без JavaScript exception. При невыделенном PBO fence может завершиться, а CPU-массив остаться нулевым; это не настоящий чёрный снимок. Контрпример с настоящими readCanvasPixels/captureCanvasDiagnostics и управляемой GL-границей подтверждает этот отдельный дефект, но не объясняет историческую потерю GPU-контекста.
- Reader проверяет GL error и context loss после enqueue и после копирования готового PBO. Неуспешное наблюдение возвращает null с прежним восстановлением bindings и освобождением ресурсов; синхронного pixel fallback нет. Проверка статуса не заменяет fence: ожидание по-прежнему проходит с нулевым timeout, CPU-копирование начинается только после сигнала.
- getError неизбежно снимает прочитанный error flag. Предварительной очистки или drain-цикла нет: уже существующая ошибка консервативно отвергает снимок, оставшиеся flags не потребляются. Проверка одного BUFFER_SIZE была бы недостаточна для отказов readPixels/getBufferSubData. Реальный чёрный/полностью прозрачный кадр остаётся допустимым, цвет не используется как признак ошибки.
- Регрессии используют production reader и scene diagnostics, без копии алгоритма: silent allocation/read/copy errors, context loss во время копирования, сохранение новых bindings между кадрами, cleanup и исправные чёрный/прозрачный кадры. Это не закрывает fresh review и обязательные final-tree/exact-SHA gates T16.
- После исправления build/typecheck и1563 runtime tests,34 helper/routing,35 real-PG authority и4 CI-inclusion checks прошли. Прежний reader проваливает5 новых отрицательных проверок и сохраняет2 положительных. Обычный canvas spec4/4 и настоящий runtime→HTTP→PG healthy/lost1/1 прошли без retries/skips; аппаратная причина прежней непостоянной потери контекста по-прежнему не установлена.

## D-090 — 2026-11-02 — Изолировать время жизни браузера четырёх initial entrants
- Решение об изоляции **заменено D-091** после проверки на628d5ae; остальные наблюдения ниже относятся к этому эксперименту.
- В исходном initial отказе на1fc5cd6 page-clock firstReady→Worker creation занял17970.4ms, prepare→init2754.8ms, activate21376.3ms; entry20000 уже истёк, claims0/arrivalAllowed=false. Единственная Worker generation и успешный поздний room.ready не подтверждают повторные старты или потерянный ACK. Старый trace не разделяет artifact verification и dynamic host import до Worker, поэтому точная физическая причина этого интервала не назначается.
- Actual Controller tests с управляемыми content/start promises подтверждают: одинаковые binding/revision/lease renewals не отменяют подготовку и не сериализуют discovery с VM startup. Disable и истечение непродлённого lease по-прежнему запрещают поздние эффекты. Initial observer читает обычные debug поля, а не canvas/readback; оснований менять polling или RAF по этому отказу нет.
- В свежем браузере неизменённый полный initial сценарий прошёл: четыре trusted normal UI admissions, четыре correlated accepts и distinct seats, lifecycle/late/reload/reconnect/disable; firstReady→activate8893.1–13008.8ms. Passive startup phases отличают быстрый сетевой body от отложенного page callback. Это сравнение условий, не доказательство устранения исторической GPU loss.
- Только initial four-client scenario получает собственный Browser вместо worker-scoped браузера после других SDK/canvas/public-demo тестов. BrowserType.launch без переопределений наследует текущий профиль проекта; actual Chromium comparison подтвердил совпадение всех49 launch arguments, кроме собственного user-data-dir, и версии. Локальная и staging-extended обёртки используют тот же export; браузер закрывается и при ошибке, worker browser не закрывается.
- Все четыре contexts, настоящие сцены/native WS/обычные роли и UI barrier сохраняются; execution/cache warmup до entry нет. Entry20000/arrival5000/claim3000/initial60000, authoritative/current-generation/client/OLD/pending assertions не меняются. Negative control с четырьмя server seats и standing четвёртым client остаётся FAIL. Изоляция не заменяет fresh review/focused/package/full и exact-SHA поставку; все13 критериев остаются обязательными.

## D-091 — 2026-11-02 — Не принимать изоляцию Browser за достаточное исправление
- Exact628d5ae initial-only на собственном Browser/исходном profile/8CPU завершился0PASS/1FAIL без retries/skips; сели3/4. У неуспешного клиента platform-ready19366→activate30617.8ms укладывается в entry20000, но requested32915.8→retired34448.1→native ACK35753.5ms отменяет pending до ответа. ACK пришёл через2837.3ms, callback native→app практически без задержки. Следующая VM активировалась40565.2ms при уже закрытом arrival window. Это другая наблюдаемая ветка, не повтор прежнего отказа claims0.
- Собственный Browser не устранил нарушение timing contract, поэтому изменение withAutoSeatBrowser и его unit cases удалены; production и browser scenario возвращены к прежней реализации. D-090 не является принятым исправлением. Управляемые регрессии identical refresh/content/VM/disable и отрицательная проверка server-seated/client-standing сохранены.
- Initial-only FAILED остаётся исходным результатом; диагностический initial PASS на1fc не подменяет приёмку628d5ae. Complete auto-seat не запускался после этого отказа. Недостаточно данных, чтобы приписать retirement конкретному lease/visibility/VM источнику или физическому GPU-дефекту; одного final running/failure=null для этого недостаточно.
- Безопасное исправление не установлено. Сохраняются все13 обязательных критериев и прежние deadlines; содержательное ревью и все final-tree gates после новых regression tests требуют свежего состояния. Дополнительные случайные browser/whole-gate повторы не назначаются.

## D-092 — 2026-11-02 — Сохранять источник retirement, не выводить его из cancelled claim
- Settlement retired создают разные ветки Controller: expiry/availability/отказ discovery, удаление или замена binding, session stop и failEntry. Ограниченная история сохраняет причину из самой ветки, monotonic время, ordinal экземпляра, generation/revision, busy/start/fetch и действительность lease. Первые32 записи не заменяются последующей здоровой VM; идентификаторы, команды, токены, URL, конфигурация и source не сохраняются. Диагностика не управляет lifecycle, scheduling или authority.
- Actual Controller/Broker/SeatAdapter/KernelClient/QuickJS control воспроизводит pending claim на4000ms и expiry-retirement на5000ms: через1000ms после claim, до late accepted answer, отдельно от lost-answer3000. Непродлённый lease во время content/VM startup запрещает позднее завершение; одинаковые renewals сохраняют подготовку и независимый discovery. Свежая authority принимается и при реальном pending room.ready/claim без новой VM. Binding revision change, availability loss и instance failure имеют разные причины; bounded history сохраняет ранний факт. Negative controls по-прежнему отвергают подавленный retire и четыре server seats при standing client.
- Единственный initial case с этой историей завершён1/1 PASS: четыре normal UI admissions, correlated accepts, distinct seats и прежние lifecycle/authority/no-ghost assertions. На всех клиентах виден expiry до готовности платформы; у четвёртого также expiry во время подготовки VM. После claim до accepted retirement не было; pending-retirement из D-091 не повторился. Этот PASS не восстанавливает отсутствующую причину старого отказа и не является исправлением.
- Функциональные изменения без причинного основания не выбираются. TTL, бюджеты,20000/5000/3000/60000, fences, роли и assertions сохранены. Runtime build,120 targeted tests и4 routing checks прошли; общий срез остаётся NOT_READY до установления безопасного решения и всех final-tree/exact-SHA gates.

## D-093 — 2026-11-04 — Истечение lease при идущем продлении не прерывает подготовку плагина
- Условие: запись в предстартовой подготовке (идёт загрузка содержимого или запуск host, instance ещё нет), срок lease истёк, а запрос продления запущен и не старше своего таймаута 2000 мс. Это наблюдалось в CI 41712104271 на неуспешном клиенте initial: запросы 29829 и 37902, истечения 31342,8 и 38783,8 при fetchPending=true, тело первого ответа получено раньше срока, но колбэк задержан занятым главным потоком. Две подготовки были прерваны, запусков стало три вместо одного, activation 45325 опоздала на 2,7 с к сроку окна входа 42607; к записанному закрытию 42870 это 2,5 с. Отказы public demo и seating на R3 с тем же рисунком этим не объясняются: их связь не проверялась.
- Последствие прежнего поведения: прерывание и новый запуск расходовали попытку из бюджета 3/600000 при действующей на сервере authority; окно входа истекало, хотя свежий ответ уже был получен.
- Решение: такая запись не прерывается и не расходует новую попытку, пока продление не завершится. Принятое продление оставляет ту же подготовку. Отказ, ошибка, недоступность, stale, снятие или замена binding и потеря доступности прерывают её прежними ветками и с прежней причиной; поздний результат не создаёт VM.
- Граница ожидания: продление старше 2000 мс на момент истечения не считается идущим, запись прерывается как прежде. Более молодое ограничено собственным таймаутом snapshot: настоящий HTTP-клиент с зависшим fetch завершает его ровно на 2000 мс ветвью refresh-failed. Значение таймаута вынесено в именованную константу и не менялось.
- Что не изменилось: в промежутке permit пуст, broker отвечает lease-expired, статус, команды, запуск VM, установка instance и room.ready не проходят; подготовка, завершившаяся в промежутке, не получает эффектов и требует новой попытки. Занятый или неготовый instance и истечение без идущего продления обрабатываются как раньше. Ожидающая заявка на место отменяется при истечении и в удержанной подготовке; поздний ACK grant не использует. TTL5000, бюджет, entry20000, arrival5000, claim3000, assertions и права не менялись, закрытый grant не переоткрывается.
- Отдельное следствие удержания: гость, запущенный в промежутке, может получить отказ lease-expired и завершить init ошибкой. Без учёта этого прерванная раньше подготовка превратилась бы в постоянный отказ, поэтому ошибка подготовки, пережившей промежуток, до установки instance считается прерыванием: запись истории с lease-expired и кодом ошибки, повторный запуск после свежей authority за счёт обычного бюджета. Синхронное исключение хоста уже после установки instance этого отказа не касается и идёт обычной веткой, как без промежутка: terminate и failed. Гость, перехвативший отказ в init, продолжает работу без этого эффекта, как и обычный idle instance при отказе broker.
- Проверка: настоящие Controller, Lease, Broker, SeatAdapter, KernelClient, QuickJS и HTTP-клиент. До правки 20 из 66 проверок двух файлов падали, включая удержание content и host start; 19 из них относятся к новым сценариям, существующий negative control упал только вслед за ними: отдельно он проходит и без правки. Снятие условия in-flight, границы возраста, ограничения на подготовку без instance, отмены заявки, не постоянного отказа и проверок permit ломает соответствующие проверки. Runtime build и typecheck прошли, runtime-тесты 1596/1596. Обычный локальный прогон public demo, auto-seat и seating с одним worker без retries: 6/6 PASS за 780,1 с, рассажены 4/4. Удержание не оставляет записи в истории, поэтому этот прогон не показывает, срабатывало ли оно; один PASS не доказывает устранение отказа под нагрузкой. Проверка исключения хоста при установке после промежутка и условие установленного instance добавлены позже: снятие условия оставляет VM с running=1 и падает на настоящих Controller, SeatAdapter, KernelClient и QuickJS; runtime-тесты с ней 1599/1599, браузерные прогоны после этого не повторялись. Обязательные итоговые проверки дерева и exact-SHA остаются открытыми.

## D-094 — 2026-11-04 — Скомпилированный читатель canvas читается при исполнении теста, а не при загрузке spec
- Условие: tests/e2e/canvas-diagnostics.spec.ts читал apps/runtime-web/dist/canvas-readback.js на верхнем уровне модуля. Playwright загружает все spec при любом --grep, а задания deploy gate, Rutube canary и staging-extended ставят зависимости без сборки. Отказ наблюдался в задании Rutube canary прогона Staging Deploy 41904866860; в чистом дереве 2296bc2 после установки зависимостей без сборки --list падал с ENOENT и Total 0 на всех четырёх наборах: staging, staging-extended, rutube-canary, rutube-full.
- Последствие: коллекция прерывалась до запуска первого теста, поэтому ни один опубликованный набор на этом SHA не мог выполниться, хотя сами canvas-кейсы не имеют тегов и в эти наборы не входят.
- Решение: чтение и подготовка источника перенесены в test.beforeAll того же файла. Хук выполняется, только когда выбран хотя бы один тест файла; так же, во время исполнения, сборку читает media-identity-transport.spec.ts. Перенос в общий helper не нужен: читатель используется только здесь. Отсутствие dist при запуске самих canvas-кейсов остаётся явным отказом: первый падает с ENOENT, остальные не запускаются; пропуска нет.
- Что не изменилось: проверки, assertions, таймауты, теги, состав наборов, аргументы запуска и workflow. Других чтений сборки при загрузке нет: вторая ссылка на dist на верхнем уровне, framePeerModulePath в frame-credential.spec.ts, только вычисляет путь, а файл открывается при исполнении.
- Проверка: в том же чистом дереве без сборки все четыре списка строятся с кодом 0: staging 54, staging-extended 6, rutube-canary 1, rutube-full 1. Они построчно совпадают со списками исходного кода с заглушкой читателя, поэтому правка не меняет состав. С настоящей сборкой spec прошёл 4/4 в браузере с одним worker. Сами опубликованные наборы на новом SHA не запускались и остаются открытыми до поставки.

## D-095 — 2026-11-05 — Тесты плагинов без проверок кадров рендерят редко; автопосадка проверяет логику на крошечной сцене
- Условие: на раннере CI нет GPU, поэтому браузеры программно рендерят настоящую meeting-room-basic. В CI 41907007394 загрузка сцены заняла 22,5 с после открытия барьера, активация от firstReady 10,8–15,8 с при окне входа 20 с, а один клиент не сел. В CI 41906998923 статус плагина в public demo не вышел из Loading за 30 с.
- Последствие: тесты отказывали из-за нехватки времени главного потока, а не из-за логики плагина или автопосадки. Продуктовые сроки и код из-за этого не меняются.
- Причина, измеренная по занятости главного потока: при непрерывном цикле программного рендера с интервалом 100 мс занятость у участника public demo на настоящей сцене составила 0,98. При интервале 2000 мс на авторском цикле, с той же сценой и двумя браузерами, она составила около 0,4. Какая именно операция внутри кадра тратит время, не устанавливалось.
- Решение для public demo: общий сценарий, локально и на стенде, идёт с интервалом кадров 2000 мс с момента создания контекста. Значение по умолчанию 100 мс для остальных тестов не изменилось. Авторский цикл выполняется, когда в комнате только Host и первый Member; второй Member и Guest входят при работающем плагине, что дополнительно проверяет поздний вход. Сразу после входа Guest выполняются те же отказы автора: пять запросов 403, неизменный hash библиотеки, скрытый интерфейс автора и отсутствие нативного исполнения.
- Решение для автопосадки: auto-seat и seating локально и в CI идут в комнате собственного шаблона одноразовой схемы с inline-сценой из одного треугольника и восемью местами seat-01..08, частота кадров там прежняя. Кейс без мест остаётся на своей сцене без якорей. На стенде шаблоны каталога запрещают подмену сцены, а записи в БД там нет, поэтому runAutoSeatScenario получил параметр simultaneousEntrants: 4 локально и в CI, 2 на стенде в настоящей meeting-room-basic с интервалом кадров 2000 мс.
- Покрытие: гонка четырёх клиентов, настоящие браузеры, внешний плагин и authority проверяются локально и в CI на крошечной сцене. Четыре участника в настоящей сцене проверяются в public demo локально и на стенде с редкими кадрами. Одновременный вход двух, занятое место, конфликт протокола, переподключение и отсутствие призраков в настоящей комнате проверяются на стенде с редкими кадрами. Настоящая сцена с четырьмя людьми и обычной частотой кадров проверяется на ручной встрече T17.
- Потеря: гонка четырёх клиентов автоматически больше не проверяется в настоящей сцене. Public demo и автопосадка на стенде больше не проверяются автоматически при обычной частоте кадров. Отдельная проверка running 0 у Guest до включения плагина невозможна: его в этот момент нет в комнате; у Host и Member она остаётся.
- Что не изменилось: продуктовый код, assertions, TTL, бюджет 3/600000, entry 20000, arrival 5000, claim 3000, таймауты шагов и строка t16_arrival_timing. Настоящая сцена, четыре участника public demo и publicDemoAuthorityChanges остаются на месте.
- Проверка: локальный прогон при интервале 2000 мс с момента создания контекста: public demo прошёл до конца за 290 с. Затем один общий прогон, worker 1, без повторов: auto-seat 4 из 4, seating 1 из 1, public demo за 250 с, всего 6 из 6. Занятость главного потока с четырьмя браузерами в конце public demo 0,74–0,82 при длинных задачах в среднем 1041–1645 мс: заметно ниже 0,98, но намного выше 0,4 на двух браузерах. Retirements у Host и первого Member только binding-replaced и binding-removed от смены версии и отключения. У Guest в этом прогоне были lease-expired и refresh-failed во время входа и session-stop при удалении; в предыдущем прогоне также были lease-expired и snapshot-rejected у второго Member, lease-expired и refresh-failed у первого Member после перезагрузки и повторные lease-expired и refresh-failed у Guest. Плагин после входа восстанавливался. Без сборки списки staging 54 и staging-extended 6 строятся с кодом 0, functional-frame-budget.spec.ts 6 из 6. Автопосадка с двумя клиентами на настоящей сцене при 2000 мс ещё нигде не запускалась; на стенде и в CI это изменение ещё не проверено.
