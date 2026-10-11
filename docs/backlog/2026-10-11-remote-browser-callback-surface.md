---
name: remote-browser-callback-surface
date: 2026-10-11
source: T01a-S2b-AD
area: backend
status: parked
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

- apps/remote-browser/src/index.ts:724 — executor callback.
- apps/room-state/src/index.ts — forwardRemoteBrowserPatch и callback route.
- apps/room-state/src/state.ts — patchRemoteBrowserExecutorState.
- docs/arch/09_phase_m1_8_multi_surface_layouts.md — несколько поверхностей.
