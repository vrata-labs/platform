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
