---
name: remote-browser-callback-surface
date: 2026-10-11
source: T01a-S2b-AD
area: backend
status: promoted
priority: P2
jira: не заведена
---

# Remote-browser callbacks не работают на поверхности, отличной от debug-main

## Что не так

Room-state принимает создание и open-url remote-browser объекта на laptop-screen
или whiteboard-wall. Исполнитель отправляет callbacks с фиксированным
surfaceId=debug-main. Проверка object.surfaceId отклоняет их с
object-surface-mismatch. Mark-publishing прерывает запуск publisher, а последующий
mark-failed также отклоняется. Объект остаётся loading без опубликованного видео.

## Почему всплыло

При проверке executor binding обнаружено, что
patchRemoteBrowserExecutorState использует literal debug-main, независимо от
surface серверного объекта. Это предсуществующее поведение.

## Почему не сейчас

Текущий срез закрывает frame credential, текущий executor instance и socket/peer
lease. Callback routing и запуск LiveKit publisher требуют отдельной проверки
обычного media-пути на нескольких поверхностях.

## Что сделать

Воспроизвести полный open-url → mark-publishing → mark-active на каждой разрешённой
поверхности. Проверить, откуда session получает фактический surfaceId и как он
сохраняется при replacement/retry. Добавить сценарий с настоящим publisher,
подтверждающий видео на выбранной поверхности и отказ чужого surface callback.

## Стоимость и эффект

Не оценено. Затрагивает remote-browser на дополнительных разрешённых поверхностях
и основной media-срез; сценарий только на debug-main дефект не обнаруживает.

## Ссылки

- apps/remote-browser/src/index.ts — remoteBrowserExecutorCallbackBody и patchRemoteBrowserExecutorState
  (executor callback), resolveRemoteBrowserSessionSurfaceId (surfaceId из запроса запуска).
- apps/room-state/src/index.ts — forwardRemoteBrowserPatch и callback route.
- apps/room-state/src/state.ts — patchRemoteBrowserExecutorState.
- docs/arch/09_phase_m1_8_multi_surface_layouts.md — несколько поверхностей.

## Актуальность 2026-10-26
Литерал `surfaceId: "debug-main"` остаётся в `apps/remote-browser/src/index.ts:731`.

## Сделано 2026-10-27

Влито в main в #148, поставлено на stage 2026-10-27.

- Room-state передаёт исполнителю поверхность объекта при каждом запуске сессии:
  первый open-url, повтор после mark-failed и замена URL.
- Remote-browser хранит `surfaceId` в сессии и подставляет его во все callbacks вместо
  литерала `debug-main`. Запрос без `surfaceId` (старый room-state) по-прежнему
  получает `debug-main`, некорректное значение отклоняется как `invalid_session_payload`.
- Проверка `object.surfaceId` в `patchRemoteBrowserExecutorState` не ослаблена. Тест room-state
  на `laptop-screen` и `whiteboard-wall`: mark-publishing, mark-active и mark-failed с
  поверхностью объекта принимаются, с чужой поверхностью отклоняются с
  `object-surface-mismatch` и не меняют состояние объекта.

## Осталось

Сценарий с настоящим publisher: open-url → mark-publishing → mark-active на `laptop-screen`
и `whiteboard-wall`, видео на выбранной поверхности и отказ callback с чужой поверхности.
Нужен стенд и LiveKit, в unit-тестах это не проверить. В плане по бэклогу — пункт 15.

Проверка 2026-10-27 на stage (floor 2, codec 3): в комнате `meeting-room-basic@2.0.0` объект remote-browser на
`debug-main` проходит loading → publishing → active примерно за 3 с. На `laptop-screen` и `whiteboard-wall` в
шаблонной комнате его не создать: `laptop-screen` нет в шаблонах каталога (`missing-surface`), `whiteboard-wall`
принимает только whiteboard и markdown-board (`unknown-object-type`), а комнату со старым шаблоном 0.1.0 создать
нельзя (`deprecated_template`). Remote-browser на этих поверхностях бывает только в старых комнатах 0.1.0, где
действует `createDefaultRoomMediaObjectsState`; проверка в такой комнате требует чужой комнаты на стенде.

Закрыто 2026-10-27 как есть: проверку в чужой старой комнате 0.1.0 со сменой host решено не проводить.
