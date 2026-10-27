---
name: audio-not-rejoined-after-media-eviction
date: 2026-10-27
source: T01a S3b-4, разбор смены media namespace
area: frontend
status: new
priority: P2
jira: не заведена
---

# После серверного выселения из LiveKit звук не возвращается сам

## Что не так

Когда сервер выселяет участника из медиакомнаты (смена media namespace, подъём медиа-границы, выведение поколения комнаты), runtime только очищает ссылку на комнату (`apps/runtime-web/src/main.ts`, обработчик `Disconnected` вызывает `clearMediaRoomReference`). Новый грант не запрашивается, микрофон не восстанавливается. При этом `audioSessionJoined` остаётся `true`: кнопка показывает «Leave Audio», а `leaveAudio` ничего не делает, потому что комнаты уже нет. Пользователь без звука и без подсказки, что нужно войти в голос заново.

## Почему всплыло

Документация подъёма медиа-границы обещала, что открытые вкладки переподключаются с новыми грантами. Код этого не подтверждает: переподключение есть только для поверхностей с объектами screen-share и remote-browser (`ensureSurfaceLiveKitRoom`). Для смены namespace в S3b-4 обещание убрано, в документах сказано, что звук нужно включить заново.

## Почему не сейчас

Это поведение runtime, а не серверной сверки. Нужна отдельная правка медиа-подключения со своими тестами, вместе с пунктом voice-join-gives-up-after-ice-failure.

## Что сделать

Различать причины отключения LiveKit: при выселении сервером (participant removed, room deleted) запросить новый грант и, если участник был в голосе и сессия жива, войти заново; иначе сбросить `audioSessionJoined` и показать кнопку входа. Покрыть e2e: выселение сверкой во время разговора.

## Стоимость и эффект

Не оценено. Затрагивает всех участников при любом серверном выселении из медиакомнаты.

## Ссылки

- `apps/runtime-web/src/main.ts` — `clearMediaRoomReference`, `ensureBaseMediaRoom`, `leaveAudio`.
- [voice-join-gives-up-after-ice-failure](2026-10-26-voice-join-gives-up-after-ice-failure.md).
