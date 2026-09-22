# FEAT-032: приёмка основного каталога

Статус: подготовка guarded staging activation. Physical-device checks не выполнены.

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

Platform SHA, run URLs, фактические результаты и итоговые room URLs дописываются
после исполнения. До этого staging acceptance здесь не заявлена.

## Проверка владельцем на физических устройствах

Пользователь подтвердил Android Chrome, iOS Safari и Meta Quest. Для каждого
устройства записать модель, версию OS и browser, дату и network conditions.
Эмуляция Chromium и synthetic XR не закрывают эти строки.

| Устройство | Model / OS / browser | Personal | Meeting | Presentation | Результат |
| --- | --- | --- | --- | --- | --- |
| Android Chrome | ожидает владельца | не выполнено | не выполнено | не выполнено | pending |
| iOS Safari | ожидает владельца | не выполнено | не выполнено | не выполнено | pending |
| Meta Quest Browser | ожидает владельца | не выполнено | не выполнено | не выполнено | pending |

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
отсутствие возможности проверить сценарий в pass. Production/publication-ready
promotion остаётся открытой до результатов этих проверок.
