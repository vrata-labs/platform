# T16: безопасное приложение к журналу решений

Основание: внешний план `2026-09-25-working-meeting-and-room-plugins.md`, §0/T16/T17/§8.
Продолжение нумерации основного журнала `2026-09-26-working-meeting-implementation.md` после D-047. Исторические записи не изменяются и не копируются в это приложение.
Матрица: [T16](../validation/2026-10-31-t16-regression-matrix.md). Контракт: [JSON](../validation/2026-10-31-t16-regression.json).

## D-048 — 2026-10-31 — Отдельный T16-контракт без переноса исключений предыдущего среза

- Контекст: T15 уже принят, T16 требует нового full local после последних исполняемых изменений. Существующий общий по имени JSON фактически относится к T15 и содержит узкое исключение.
- Решение: сохранить T15 JSON неизменным, создать отдельные T16 матрицу и workflow-verify JSON, все критерии обязательны. Матрица сначала проверяется до реализации; сейчас нет commit/push/deploy и новых результатов тестов.
- Основание: внешний план §0/T16; основной журнал D-042–D-047; исходники на b7ef73e. Указанный внешний путь журнала недоступен, tracked-копия найдена в текущем main/worktree.
- Последствия: прошлые успехи/исключения не закрывают новые проверки; final-tree review/full local/exact SHA publication остаются обязательными. Внешний план до staging-приёмки не меняется; T17 остаётся открыт.
- Проверка: аудит файлов завершён; исполняемые проверки в этом этапе намеренно не запускались.

## D-049 — 2026-10-31 — Дополнять shared demo и авторитетное наблюдение, а не повторять sandbox/storage

- Контекст: normal invite/onboarding, внешний SDK/author UI, PG authority barriers и быстрый sandbox уже существуют отдельно. Public demo не связывает их в один продуктовый сценарий; auto-seat assertions не проверяют exact server participant set после lifecycle transitions.
- Решение: минимальные будущие правки — расширение существующего shared demo, пассивное наблюдение существующего room_state socket и reusable auto-seat для local/staging-extended; детерминированные protocol races без дополнительных 3D. Центральный local CI PG fail-fast закрывает найденные unconditional skips.
- Основание: строки R01–R14 матрицы. Полноценный отдельный повтор T15 storage/backup или 3D для каждого malicious payload не закрывает эти пробелы и увеличивает стоимость.
- Последствия: это выбор границ реализации, не утверждение о готовом коде. Успешные Guest denials сохраняются, роли для удобства теста не повышаются. Pose/locomotion ownership не меняется. Heavy four-client published checks остаются X, обычный gate не расширяется ими.
- Проверка: после согласования матрицы требуется реализация и все критерии T16 JSON; общее X тоже нельзя объявить зелёным по одному scoped T16 прогону.

## D-050 — 2026-10-31 — Переиспользовать CI-подтверждения published suites без второго полного прогона

- Контекст: поставка имеет отдельный операционный бриф; обычный gate и Extended workflow уже сохраняют Playwright artifacts. Повтор G/X локально после тех же успешных exact-SHA CI checks не добавляет обязательного результата.
- Решение: published suite criteria остаются required=true как evidence: проверенные run/attempt, candidate test SHA, actual mandatory cases без skips и before/after accepted/images. При необходимости локального дополнительного запуска использовать тот же опубликованный commit под арендой.
- Основание: R16, существующие staging workflows; workflow-verify допускает внешние наблюдения. Это не исключение из full local, который остаётся обязательным command.
- Последствия: не дублировать операционные инструкции в Git. Локальные команды явно выбирают уже установленный /usr/bin/node22.23.2; frozen dependencies установлены главным потоком, повторная установка Node не требуется.
- Проверка: CI/deploy/Extended ещё не запускались; все соответствующие evidence остаются открыты.

## D-051 — 2026-10-31 — Общие test-only observers без новой identity и production API

- Контекст: R06/R08/R09 требуют raw-authority proof, которого не дают клиентские проекции.
- Решение: CDP-наблюдение только уже аутентифицированного WebSocket, bounded participants/occupancy и коррелированные seat/results; состояния media сравниваются по хешу, не по сохранённому содержимому. Adversarial privileged commands отправляются по уже существующему сокету отдельным test-only hook.
- Основание: room-state protocol, normal v2 onboarding и существующие CDP PDF observers. Дополнительная observer identity изменила бы проверяемый состав участников.
- Последствия: hooks, CDP listeners и DTO очищаются в finally. Перед revoke/transfer сохраняется ссылка на именно прежний сокет; запрет проверяется его закрытием либо correlated access_denied, а не отправкой по новому соединению. Сырые frames/URL/token/config/source не включаются в отчёты. Production pose/locomotion и sandbox не меняются.
- Проверка: новый helper проходит строгую проверку типов; browser assertions ещё требуют focused/full и published прогонов.

## D-052 — 2026-10-31 — Проверять реальные permissions и явное одобрение нового hash

- Контекст: R03–R06; Guest не имеет document.view/download, а plugin API разрешает одобрить подмножество запрошенных capabilities.
- Решение: не повышать роль Guest ради PDF render. Проверять его штатный 403 и проекцию страницы; полноценный render сохраняется для Host/Member. При выборе новой версии явно подтверждать новую capability; stale CAS проверяет неизменность библиотеки. Не вводить несуществующий запрет на частичное одобрение capabilities.
- Основание: shared-types/access.ts и plugins/author-model.ts:planRoomPluginAuthorAction; прежний public demo требовал render PDF у Guest вопреки разрешениям.
- Последствия: короткий UI grant/revoke и UI transfer дополняют существующий security/PG набор, а не копируют Presenter/media suite. Former Host проверяется по текущей authority с первоначальным Bearer.
- Проверка: строгая проверка типов helpers прошла; сквозное исполнение и финальная приёмка ещё открыты.

## D-053 — 2026-10-31 — Отделить одновременную рассадку от детерминированного конфликта

- Контекст: четыре случайных seat offsets не гарантируют busy и не закрывают отменённый ACK.
- Решение: общий readiness barrier четырёх normal clients перед первым authoritative snapshot; отдельные два настоящих protocol contenders отправляют claims на одно свободное место без двух дополнительных 3D. Один browser transport witness задерживает server snapshot/accept до disable и correlated release, затем доставляет их в исходном порядке.
- Основание: seat adapter имеет entry/window/claim-response deadlines и seating-controller cancellation barrier. Нельзя продлевать их ради сценария.
- Последствия: release должен произойти до штатного 3000ms lost-answer timeout; иначе witness не доказывает disable. Протокольные contenders покидают комнату до повторной exact-set проверки. Heavy scenario остаётся local/X, не deploy gate.
- Проверка: CI PG guard и шардирование 6/6 passed; browser witness пока требует исполнения. Все критерии T16 остаются обязательны.

## D-054 — 2026-10-31 — Focused Node tests используют тот же autostart fence, что package scripts

- Контекст: первый объединённый focused запуск прерван внешним 120s лимитом; отдельный room-state запуск прерван на 60s после успешного socket assertion. Исходные логи сохранены, успех всего прогона не объявляется.
- Решение: добавить VRATA_DISABLE_AUTOSTART=1 в focused-unit command, как в штатных package test scripts. Изменять runtime lifecycle или продуктовые timeout для этого не требуется.
- Основание: apps/room-state/package.json:test и нижний autostart в index.ts. Прямой node --test без fence импортировал service entry point и оставлял запущенный сервер после assertions.
- Последствия: прерванные прогоны остаются видимыми; последующий правильный запуск не переименовывает их в успешные. Полный local и package contract остаются required=true.
- Проверка: отдельный runtime focused прошёл 355/355, room-state с fence —34/34, без skips. Исправленный общий focused-unit ещё требуется выполнить; browser/full/published gates остаются открыты.

## D-055 — 2026-10-31 — Старый focused browser прерван до исправления подтверждённых дефектов

- Контекст: на b998bc5 уже выполнялся focused; продолжение после обнаружения пяти дефектов тестовых свидетельств не проверяло бы окончательное дерево.
- Решение: установить точные PID/владение script → work-check → browser, завершить только его browser process group и оставшиеся собственные services. Runner сохранил terminal receipt до изменения файлов.
- Основание: общий focused-unit завершён:155+355 passed,0 skipped; browser receipt exit−15. До прерывания browser отметил8 passed и2 failed; итогового JSON report нет. Исходные логи/receipts не удалены и не переименованы в passed.
- Последствия: новый focused — только после commit последних правок, с отдельными именами отчётов. Старые ошибки не заменяются новым успехом. Full/package/published gates остаются обязательными; исходный checkout, внешний план и T17 не меняются.
- Проверка: все PID зафиксированного дерева завершены, локальные4416/25676/4417 освобождены. Другие процессы и контейнеры не изменялись.

## D-056 — 2026-10-31 — Реальное действие старого сокета и наблюдательный media barrier

- Контекст: surface_create_object без probeOnly:false проверял лишь permission probe и не возвращал commandId; немедленный cached media hash другого клиента не доказывал отсутствие эффекта.
- Решение: реальный поддерживаемый create на сохранённом до revoke/transfer открытом сокете, обязательный sent и correlated access_denied/missing-permission на том же socket scope. После ответа через этот же сокет отправляется безвредный participant_update с уникальным clientTimeMs; reader обязан увидеть именно этот marker в новом room_state и неизменный media hash.
- Основание: существующие dispatch/ordered socket guard и applyParticipantUpdate/broadcast; production protocol/probe не меняются. Свежесть snapshot привязана к test-only socket scope/generation/sequence, close/new connection инвалидируют старый snapshot. Reload/reconnect ждут room_state новой generation.
- Последствия: marker не меняет pose/роль/права и не сохраняется в DTO/артефактах. Потерянный/старый snapshot не закрывает проверку. Одни глобальные receive/connect counters больше не являются reconnect witness.
- Проверка: source probe реального create подтвердил correlated permission denial/unchanged media и разрешённый Host positive control; лёгкие tests отклоняют closed/overlapping old snapshots и cached/unrelated media barrier. Browser ещё требуется.

## D-057 — 2026-10-31 — No-anchor использует собственный non-reference template

- Контекст: personal-workspace-basic deprecated в active catalog; reference scene override намеренно запрещён продуктовым контрактом.
- Решение: отдельная disposable fixture добавляет свой non-reference template/version только в свою проверенную schema. Inline scene задаётся при штатном POST room; перед закрытием fixture её template скрывается, затем базовая fixture проверяет reference catalog и удаляет schema/services/files.
- Основание: storage version/hash contract и resolveRoomTemplateCreate. Замена shared template policy или shared GLB ради теста не нужна.
- Последствия: новый template не публикуется и не попадает в shared catalog; no-anchor остаётся local/C, не published X.
- Проверка: настоящие PostgreSQL/API вернули201 на inline room; meeting-room-basic сохранил2.0.0, room и fixture закрылись. Два ранних probe harness failures (непереданные VM globals/default-import interop) сохранены отдельно, не product failures. Browser assertions ещё открыты.

## D-058 — 2026-10-31 — Отменённая посадка проверяется до исправляющего empty snapshot

- Контекст: replay всего потока мог скрыть краткую ошибочную посадку последующим empty/release.
- Решение: сначала доставить только удержанные occupied snapshot/accepted с commandId отменённой попытки; дождаться фактических delivery counters и двух кадров, проверить current/pending=null и неизменный standing root pose. Только затем доставить остаток в исходном порядке, correlated release и exact authoritative empty/no ghosts.
- Основание: in-memory mutation control на существующем SeatingController: сломанное suppression проваливает промежуточный standing, хотя конечный standing восстанавливается.
- Последствия: release по-прежнему обязан уйти до штатного3000ms timeout. Нет прямых pose writes, изменения lifecycle продукта или увеличения timeout.
- Проверка: mutation control и строгие типы прошли; actual browser delivery/frame witness требует нового focused/full/X.

## D-059 — 2026-10-31 — Независимая очистка и сохранение всех ошибок

- Контекст: неуспешный enterPluginRoom мог не вернуть уже созданный context; первая ошибка cleanup могла пропустить другие contexts, внешний проект и удаление room.
- Решение: enterPluginRoom закрывает собственный context при любом неуспехе. Общий test-only cleanupAll/withCleanup независимо пытается закрыть все ресурсы; при cleanup errors выбрасывает AggregateError с исходной ошибкой и cause. Owned actor всегда пытается удалить room; pending entries дожидаются завершения после закрытия contexts, их ошибки не теряются.
- Основание: отдельные лёгкие tests на newPage/prepare/navigation/admission/scene failures, совместный primary+close failure, actor-close failure и независимость observer/contexts/author/room cleanup.
- Последствия: закономерно уже закрытые pages не требуют повторного CDP/route close; другие cleanup failures не подавляются. Production и прежний sandbox/storage suite не меняются.
- Проверка:11/11 helper tests,0 failed/skipped; строгая проверка типов пройдена. Финальный focused work-check после commit ещё обязателен; T16 остаётся NOT_READY.

## D-060 — 2026-10-31 — CI guard ограничивает каждый job независимо

- Контекст: граница секции core не распознавала e2e из-за цифры в имени; валидные настройки e2e скрывали повреждённые настройки core. Сам workflow настроен правильно.
- Решение: применить минимальное исправление tools/ci-postgres-gate.test.mjs: корректные символы job ID, прежние пять assertions в общем helper и шесть изолированных отрицательных controls core/e2e × env/image/Node. Workflow и зависимости не менять.
- Проверка: применённый файл совпадает с подготовленным исправлением; полный лёгкий набор24/24 прошёл. Независимая копия реального положительного callback отклоняет каждую из шести мутаций при неизменном другом job. Возврат только старой границы оставляет положительный callback зелёным, но ломает все шесть controls. Временная копия удалена.
- Последствия: F06 исправлен; это не результат browser, полного local или published gates.

## D-061 — 2026-10-31 — Pending-disable отсчитывает ожидание claim после нормального входа

- Контекст: завершившийся focused на3f1552c дал19 expected/3 unexpected/0 skipped/flaky за882.6s. В auto-seat accepted=false проверялось в течение15s, отсчитанных ещё до invite/onboarding/загрузки сцены. Их штатные отдельные deadlines больше этого интервала.
- Решение: сначала дождаться enterPluginRoom с реальными scene/connection, затем начать прежнее15s ожидание server accept. Добавить очищенные факты при отказе: только readiness/running/grant и булевы признаки claim/release, без идентификаторов или frames.
- Проверка: новый test исполняет реальный helper с задержанным entry; до его завершения claim poll не начинается, timeout15000/interval50 неизменны. Независимое удаление entry-first ожидания ломает этот test. Строгие типы прошли.
- Последствия: release до штатных3000ms, реальный intermediate occupied/accepted delivery, два кадра standing/unchanged pose, current-generation exact authority и отсутствие ghosts остаются обязательными. Единственность этой причины исходного browser failure требует узкого повторения; исходный failed receipt сохранён.

## D-062 — 2026-10-31 — Статус подтверждённой посадки проверяется до загрузки следующего клиента

- Контекст: room-plugin-seating упал на тексте отказа, хотя currentSeat/occupancy assertions прошли и диагностический grant=used, running=1, failed=0. Между входом Member и проверкой его принятой заявки сценарий полностью загружал третьего клиента.
- Решение: проверить прежние currentSeat/occupancy/accepted status/grant сразу после входа Member, дополнительно потребовать correlated seat_claim/result из его существующего socket. Затем вводить refusing клиента и выполнять все прежние opt-out/manual veto assertions. Observer и оба contexts закрываются независимо, включая неуспешный третий вход.
- Основание: исполнены настоящий bundled scaffold и SeatAdapter: первая VM показывает принятую заявку; новая VM при том же used grant показывает точно наблюдавшийся отказ, не снимая уже подтверждённое место. Текст поздней VM не является результатом первой заявки.
- Последствия: не заменять accepted status одной конечной посадкой и не ослаблять opt-out/manual checks. Browser должен подтвердить исправленный порядок; из имеющегося отчёта нельзя установить конкретный момент перезапуска VM.

## D-063 — 2026-10-31 — Shared demo использует существующий функциональный frame budget

- Контекст: public-demo дошёл до loaded/connected, но VM status остался Stopped/host-unavailable, running=0/failed=1; исходная performance observation отсутствовала. У соседнего seating отказа зафиксированы длинные задачи357–1041ms. В shared demo, в отличие от других multi-client meeting tests, functional frame budget не устанавливался.
- Решение: установить тот же100ms RAF budget и пассивную performance observation на BrowserContext до создания его страниц. Сигнатуры двух init helpers принимают общий addInitScript интерфейс; viewport640×400/DPR0.5 и drawing buffer320×200, сцена, PDF/audio, права, deadlines и sandbox не меняются. Новый browser test проверяет budget на первой странице, после reload и на новой странице.
- Основание: existing functional-frame-budget.ts и setup соседних presenter/tool suites. Frame starvation как причина public-demo host-unavailable остаётся гипотезой: исходный отчёт не содержит достаточных timing facts для доказательства единственной причины.
- Последствия: необходим узкий повтор трёх исходных failures и нового context-budget test в одном worker с новым report. Его успех не закрывает обязательный focused/full/package/review/CI/G/X контракт. До нового ревью общий package/full не запускать; T16 NOT_READY.

## D-064 — 2026-10-31 — Stale CAS требует допустимый PUT, а не копию read DTO

- Контекст: завершившийся narrow на a188d94 дал2 expected/2 unexpected/0 skipped/flaky за434.5s. Shared demo прошёл v1/v2 VM assertions и упал на stale CAS: expected409, received400. Context-budget и new-entry seating прошли; это не полный focused и не browser-приёмка T16.
- Основание: public-demo-plugins.ts передавал spread всей прочитанной binding. roomPluginBindingHttpDto добавляет bindingId/pluginId/generation/bindingRevision; parseRoomPluginBindingHttpBody запрещает все четыре поля до вызова author.putBinding. Следовательно этот запрос не достигал проверки revision. Отказ соответствует продуктовому HTTP-контракту, а не дефекту CAS или разрешений.
- Решение: формировать stale PUT явной проекцией разрешённых полей текущей binding. Сохранить expectedRevision1, обязательный409 и полное unchanged-library hash assertion; parser/permissions не менять. Regression использует настоящий helper, source parser и storage CAS; отрицательные controls возвращают read-only поля по одному.
- Проверка: исходный narrow failure сохранён. Лёгкий набор26/26,0 skipped и строгие типы прошли; отдельный synthetic in-memory HTTP probe получил исходный400/plugin_invalid_binding, исправленный409/plugin_revision_conflict с unchanged state и current-revision positive200. Это не browser/PG приёмка; source review a188d94 не объявляется review нового diff. Полный focused/package/full и CI/G/X остаются обязательны.

## D-065 — 2026-10-31 — Для release fence не приписывать причину без времени отдельных фаз

- Контекст: тот же narrow прошёл accepted/pending/current=null, running0 и correlated release ACK, но releaseAt−claimAt не выполнил строгую границу <3000ms. Само значение и длительности onboarding/проверок/PUT/runtime refresh в отчёте отсутствуют; intermediate replay/frame/pose assertions ещё не достигнуты.
- Основание: в RoomPluginSeatAdapter одновременно существуют cancel при retire и штатный claimResponseMs3000; RoomPluginController получает изменения через leased HTTP snapshot с bounded refresh. Из одного конечного release нельзя установить, какой путь сработал и сколько времени занял тест до disable. CPU/starvation, setup delay и поздний runtime refresh остаются альтернативами, не выводом.
- Решение: не менять продукт, порядок, таймауты и assertions по догадке. Добавить только bounded passive timing: относительные фазы entry/accept/pending/hook/disable/stop/release и до восьми runtime response observations с status/revision/числом enabled bindings. Listener и незавершённые чтения очищаются независимо; URL/token/identity/config/source/raw frames не сохраняются.
- Проверка: новый узкий run должен сохранить эти факты даже при падении на исходном fence. Regression намеренно воспроизводит release3200ms, требует прежний failure и проверяет очищенный timeline/listener cleanup. Такой тест проверяет наблюдение, а не устанавливает причину browser failure. Auto-seat root cause остаётся открытой до реального timing evidence; T16 NOT_READY.

## D-066 — 2026-10-31 — Прерванная дополнительная PG-проверка не считается успешной

- Контекст: отдельный HTTP/storage-contract запуск без PG дал45 passed/1 skipped. Повтор с собственным PG был прерван внешним60s лимитом после13 завершённых PG subtests; terminal полного набора отсутствует. Оба исходных лога сохранены, skipped/interrupted не превращены в passed.
- Решение: не повторять тяжёлый набор в этом узком этапе. После прерывания отдельно завершить очистку только своей schema, которую штатный t.after не успел удалить. Владение установлено по одному совпавшему окну создания package records и времени запуска; другая ранее существовавшая schema сохранена.
- Проверка: своих процессов этого запуска не осталось; своя schema удалена, набор ранее существовавших schema неизменен, выделенный PG сохранён. Отдельные HTTP tests прошли23/23 без skips. Эти проверки не закрывают обязательный focused-unit/package/full.

## D-067 — 2026-10-31 — Existing-socket init требует Page.enable собственной CDP session

- Контекст: terminal narrow на6d4f448:0 expected/2 unexpected/0 skipped/flaky. Demo уже прошёл stale409 и упал на отсутствии __t16HoldSocket. Auto-seat упал раньше pending-disable, на начальной посадке четырёх entrants; pending timeline в этом run отсутствует.
- Основание: настоящий Playwright-transformed installExistingSocketControl в установленном Chromium без Page.enable не создаёт hook ни после navigation, ни после reload. Единственное добавление Page.enable в ту же session даёт function в обоих случаях. Исходный script валиден, __name не содержит; это не CAS/permission failure.
- Решение: включить Page domain до регистрации persistent init script; сохранить прежние old-socket commands/denial/barrier/cleanup. Actual-helper regression закрепляет enable→register и cleanup/remove/detach. Для отдельного initial auto-seat failure добавить только пассивные allowlisted arrival phase/command/startup facts, не менять порядок или продукт по догадке.
- Последствия: прежний release<3000ms дефект ещё требует actual timeline; новое наблюдение не является его исправлением. Узкие terminal исходы фиксируются отдельно, все13 обязательных критериев, full и новое review сохранены. T16 NOT_READY.

## D-068 — 2026-10-31 — Удерживать только добровольное закрытие OLD transport, не полномочия

- Контекст: первая доказательная итерация наebad509 завершилась1 expected/1 unexpected/0 skipped/flaky за610s. Auto-seat прошёл все исходные assertions: claim/release по одному, server accept465ms, pending verified1258ms, disable requested1286ms/ack1538ms, release2607ms, далее intermediate late ACK/standing/pose и exact authority. Demo прошёл hook и UI revoke, но OLD command получил closed, не sent. Прежние failures сохранены; случайный auto-seat PASS не объясняет предыдущие initial-seat/release failures.
- Основание: main.ts:applyAccessDebug при смене роли явно вызывает roomStateClient.close и штатный reconnect; room-state-client.ts:close вызывает socket.close. Hook сохранял лишь ссылку на сокет. Room-state допускает несколько сокетов одного PID без создания нового participant; все эффекты v2 повторно проверяют свежую API authority. Runtime callbacks старого поколения уже игнорируются.
- Решение: test-only hold откладывает только вызов close у выбранного уже открытого OLD socket. Нормальный runtime reconnect, server-initiated close, permissions/expiry и fresh authority не меняются. Тест не открывает сокеты и не меняет server state. После denied WS и fresh ordered media barrier release в finally восстанавливает close и завершает отложенное закрытие. Denial теперь дополнительно привязан к scope/generation, снятым ДО UI revoke/transfer, а не просто к совпадению sent/result на произвольном новом соединении.
- Проверка: лёгкий набор29/29 без skips; actual-helper regressions проверяют OLD-not-new target, отсутствие создания транспорта самим hold, обычный close nonheld, непрепятствование server close, restore/cleanup при failure. Строгие типы прошли. Отдельный Chromium+native WS mechanics probe подтвердил real send именно на OLD transport после voluntary close, release retirement и server close; это synthetic transport proof, не authority acceptance. Второй и последний доказательный browser run должен завершиться на новом точном SHA; его исход не предрешён. Никаких продуктовых timing fixes по auto-seat не внесено.
- Последствия: сохранить release3000ms, intermediate/two-RAF/pose, normal onboarding/Guest403/external SDK и весь13-required/full контракт. Новый substantive review и общий focused/package/full/CI/G/X ещё обязательны; T16 NOT_READY.

## D-069 — 2026-10-31 — Остановить узкую стабилизацию на доказанном initial grant blocker

- Контекст: вторая и последняя разрешённая доказательная итерация наc0837ded958e9e577704a2808bd0112d35c34177 завершена, не оставлена в очереди:1 expected/1 unexpected/0 skipped/flaky,475.8s. Shared public demo passed целиком, включая pre-demotion OLD-scope correlated denial/fresh unchanged media barrier и normal UI grant/revoke/transfer. Auto-seat снова упал на исходном initial-seat timeout60000ms, до pending-disable.
- Факты: barrier открыт через25506ms от начала four-entry setup; entriesComplete26239ms. Все4 clients loaded/connected=true, VM running1/failure=null, seating ready/correlation/online=true; grant=closed, candidates0, inFlight=false, pending/seated=false, observed commands пусты. Это не busy race, rejected claim или release timeout: claim не начат. VM failure не объясняет этот run.
- Граница вывода: конечные diagnostics не сохраняют причину и момент closed, а openedAtMs при closed всегда null. Поэтому они не различают окно entry/arrival, manual/offline veto и доставку room.ready. Нельзя заключить, что barrier25506ms превысил entryMs: entry отсчитывается от реальной platform readiness, не от начала Node setup. Успешный release2607ms первой итерации не закрывает причины прежних failures.
- Решение: не вносить неподтверждённый timing/product fix и не делать третью browser итерацию. Для отдельного следующего этапа нужны bounded переходы waiting/armed/open/closed с monotonic временем, причиной закрытия и фактом доставки room.ready; authority/permissions/3000ms и normal onboarding остаются неизменны. Наблюдательная диагностика явно не объявлена решением auto-seat.
- Проверка/очистка: оба узких запуска terminal. На втором точном SHA порты4416/25676/4417 свободны, fixture schema set неизменен2,38 прежних artifacts unchanged, git clean. Собственный PG сохранён главному потоку. Внешний план/source checkout/T17, sandbox/storage и product source не менялись; push/deploy/lease/общий focused/package/full не выполнялись. T16 NOT_READY; source review после executable изменений ещё открыт.

## D-070 — 2026-10-31 — Причину закрытия arrival grant сохранять до исправления поведения

- Контекст: отдельно согласован причинный разбор initial-seat failure после D-069; конечный closed не различает manual/offline veto, entry/window expiry и доставку room.ready.
- Решение: добавить в существующий diagnostics ограниченные восемью записями identity-free переходы grant с monotonic временем/причиной и room.ready dispatch/completion. Сохранить условия переходов и порядок вызовов, не добавлять таймеры, API или изменение планирования. Сначала воспроизвести исходный сценарий с этими фактами, затем выбирать минимальное исправление.
- Ограничения: 3000/5000/20000ms и initial60000ms неизменны; старые failures сохраняются. Не более двух новых доказательных browser итераций. Общие focused/package/full и публикация в этом этапе не выполняются; все13 обязательных критериев остаются открыты.
