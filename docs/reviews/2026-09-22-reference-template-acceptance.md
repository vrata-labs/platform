# FEAT-032: приёмка основного каталога

Статус на 2026-09-23: **ACCEPTED_BY_OWNER — этап FEAT-032 закрыт**.
Три reference templates активированы в основном каталоге staging; автоматическая
приёмка дополнена итоговым положительным вердиктом владельца.

## Итоговая приёмка владельцем

После самостоятельного входа в комнаты, осмотра сцен и взаимодействия с ними
владелец подтвердил:

> Смотри, я зашел, покликал, посмотрел - в плане самих сцен входа и т.п. все супер. Я думаю весь шаг можно засчитать сделанным. Есть естественно какой-то набор замечаний, но он не относится к этому этапу

Решение: текущий этап стандартных комнат, сцен и входа принят и завершён.
Упомянутые замечания владелец явно отнёс за пределы этого этапа; конкретный список
ещё не передан и будет предметом отдельных задач.

Модели устройств и результаты по каждому пункту исходной device-матрицы в вердикте
не перечислены. Основание закрытия ручной приёмки — решение владельца; отдельные
device measurements не подменяются отметками о прохождении.

## Подтверждённый staging результат

- Deployed platform commit: `8004b687c1e6e8eaf235e72fa3ebe8fbbe210b54`.
- [CI 35815197550](https://github.com/vrata-labs/platform/actions/runs/35815197550) — success.
- [Docker Publish 35815197571](https://github.com/vrata-labs/platform/actions/runs/35815197571) — success.
- [Staging Deploy 35817770707](https://github.com/vrata-labs/platform/actions/runs/35817770707) — success:
  40 baseline tests passed, пять product scenarios ещё не запускались до activation;
  отдельный обязательный в этом deployment Rutube scenario прошёл.
- [Staging Template Catalog 35818742548](https://github.com/vrata-labs/platform/actions/runs/35818742548) — success:
  **45/45**, без skipped/flaky. Проверены active catalog, UI/API create, private
  workspace/notes/access, восемь Meeting seats, spatial audio, PDF late join и
  реальные декодированные screen-share кадры у muted viewer без публикации микрофона.
- Local verification: runtime build и **765/765** package tests, lint/typecheck,
  full local e2e **142/142**. Все шесть historical/product template–scene pairs
  сверены с exact repository SHAs и asset hashes.
- Публичный GET /api/templates после gate повторно подтвердил ровно три active
  entries версии 2.0.0. Browser-снимки Personal, Meeting, Presentation/PDF и
  Presentation/screen share просмотрены против опубликованных scene previews.

## Откат и повторы

Immutable Wave 2 rollback SHA — `a0238a515987c95e455c45b1e6c8017953314eef`.
Проверен фактический путь active catalog → Wave 2 transaction → штатный image
rollout baseline: [catalog rollback 35808601849](https://github.com/vrata-labs/platform/actions/runs/35808601849)
и [последующий deployment 35809821224](https://github.com/vrata-labs/platform/actions/runs/35809821224).
Существующая reference-комната сохранила binding 2.0.0 и оставалась читаемой после
возврата каталога; диагностическая комната удалена после окончания расследования.

Промежуточные gates останавливали rollout/activation и возвращали baseline.
Исправлены stdin наследование в deployment helper, ожидание guest entry, ожидание
sender snapshots, on-demand подключение muted screen-share viewers и ложный
metadata-only subscription count. Main CI финального commit потребовал повтор
после нестабильного checkbox interaction; повтор того же commit прошёл. Финальные
deployment и activation runs, указанные выше, зелёные.

## Ссылки для physical-device QA

- [Создание комнат](https://158.160.10.234.sslip.io/control-plane) — три реальные
  previews и обычный create flow.
- [Meeting Room v2](https://158.160.10.234.sslip.io/rooms/reference-meeting-200-8004b68?role=host).
- [Presentation Room v2](https://158.160.10.234.sslip.io/rooms/reference-presentation-200-8004b68?role=host).
- Personal: в новой browser session открыть
  [входную комнату](https://158.160.10.234.sslip.io/rooms/demo-room) и нажать
  **Open my room**. В HUD должна появиться Personal Workspace v2.0.0 с private notes.

Параметр role=host в ссылках Meeting/Presentation использует существующий staging
dev-role доступ для проверки presenter controls. Для обычных приглашений доступ
по ролям выдаётся через invite flow. Invite/access tokens в этот документ не входят.
Обе постоянные QA-комнаты и self-service Personal дополнительно открыты в браузере
на финальном deployment: loaded, missingAssets=[], integrityRequired=true;
Meeting join-muted=false, Presentation join-muted=true, Personal notes scope=private.

## Integration checkpoint

- Wave 2 integration: platform PR #106, merge
  `9f3b4113ca765b35c6a8ed5acbfd986cecd5079c`.
- PR CI `35739538810` и main CI `35741643620` прошли; Docker Publish
  `35741639864` опубликовал immutable images.
- Первый deployment `35742013889` остановился на preflight нового Hall URL (404).
  В SSH-скрипте Docker subprocess унаследовал stdin и прочитал оставшиеся команды:
  после catalog precheck image rollout не был выполнен. Это не успешная проверка
  нового image и не доказательство image rollback.
- Продолжение закрывает stdin subprocess и проверяет сохранность входного потока
  отдельным regression test. Новый successful staging SHA и Wave 2 marker должны
  быть получены штатным повторным deployment после публикации исправления.

## Что принимается

| Шаблон | Версия | Scene release | Repository commit |
| --- | --- | --- | --- |
| Personal Workspace | 2.0.0 | personal-workspace-v1@0.4.2 | a5cfb79c478492632e639fd6704eee02f2306fbd |
| Meeting Room | 2.0.0 | warm-modern-meeting-room-candidate-01@0.3.4 | a237ab799acbee3932846147c9f48bf1d1b4aaa8 |
| Presentation Room | 2.0.0 | presentation-room-v1@0.4.2 | f6661970535bb316642fcfc3c2c5df21b963ce30 |

Personal/Presentation сохраняют принятые пользователем GLB/preview 0.4.1 и имеют
отдельное разрешение на основной выпуск. Meeting сохраняет принятый вид 0.3.3:
shipping 0.3.4 прошла 17 побайтно одинаковых browser pairs. Это не заменяет проверку
нового template flow и производительности на физических устройствах.

## Автоматическая staging-проверка

После успешного Wave 2 deployment workflow `Staging Template Catalog`:

1. Сохраняет отдельные legacy regression fixtures с их binding 0.1.0 до активации.
   На повторных запусках проверяет exact binding, не пересоздаёт deprecated rooms.
2. Проверяет image SHA, успешный deploy marker, immutable Wave 2 rollback marker
   и actual asset bytes; атомарно активирует три templates.
3. Выполняет полный staging suite: старые сцены/медиа/аватары и новые product flows.
   Legacy fixtures редактируются через обычный API, после теста выключаются.
   Product scenarios создают новые комнаты через UI/API, не используют fixtures
   как подмену проверки create.
4. Проверяет private workspace/notes/owner access, Presentation PDF page sync и
   late join, Meeting surfaces/eight seats/spatial audio. Сохраняет normal-product
   screenshots. Локальный suite дополнительно проверяет corrupted mirror.
5. При неуспехе возвращает Wave 2 catalog и запускает обычный Staging Deploy на
   immutable rollback SHA. Отдельно дождаться результата этого deployment.

Фактические platform SHA, run URLs и room URLs приведены выше. Raw screenshots,
runner reports и безопасные media diagnostics доступны во вложениях соответствующих
workflow runs. Итоговый ручной вердикт владельца зафиксирован в начале документа.

## Исходная device-матрица и чек-лист

Изначально были согласованы Android Chrome, iOS Safari и Meta Quest. Владелец
закрыл этап общим вердиктом после своей проверки; отдельный протокол по моделям,
OS/browser и каждому устройству не предоставлен. Таблица сохраняет границы
имеющихся сведений, а чек-лист ниже может использоваться в последующих задачах.

| Устройство | Model / OS / browser | Personal | Meeting | Presentation | Результат |
| --- | --- | --- | --- | --- | --- |
| Android Chrome | не указаны | не детализировано | не детализировано | не детализировано | отдельный протокол не предоставлен |
| iOS Safari | не указаны | не детализировано | не детализировано | не детализировано | отдельный протокол не предоставлен |
| Meta Quest Browser | не указаны | не детализировано | не детализировано | не детализировано | отдельный протокол не предоставлен |

Общий сценарий для каждой сцены:

- Открыть комнату после очистки cache/в новом browser context; записать время до
  usable scene. Цель cold load — не более 20 секунд на согласованной сети.
- Проверить первый кадр, читаемость материалов и панорамы, отсутствие missing
  assets, чёрных/прозрачных пятен и потерянных surfaces. Сделать обычный screenshot.
- Пройти от spawn к рабочему месту/экрану; сесть и встать, проверить высоту глаз,
  отсутствие движения сидя и корректное освобождение места для второго клиента.
- Personal: открыть собственную комнату через My Space, проверить private notes,
  сохранение после reload и отказ постороннему без разрешённого invite.
- Meeting: два участника видят друг друга, голос слышен пространственно, доска
  синхронизируется, разные seats доступны и не блокируют проходы.
- Presentation: join-muted выбран по умолчанию, PDF переключается синхронно,
  поздний участник видит текущую страницу; проверить screen share на основном
  экране с поддерживающего capture браузера. Получатель на mobile/Quest должен
  видеть поток; отсутствие capture API фиксируется отдельно от просмотра.
- Quest: дополнительно реальные controllers, ray, snap-turn, teleport, seating,
  положение self hand markers после поворота/телепорта и комфорт движения.

Для дефекта записать room/template version, устройство, действие, наблюдаемое
поведение и screenshot/video без invite/access tokens. Не превращать timeout или
отсутствие возможности проверить сценарий в pass. Замечания вне принятого этапа
оформляются отдельными задачами после получения их описания.
