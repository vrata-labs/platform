---
name: e2e-invite-token-missing-field
date: 2026-10-27
source: сессия 2026-10-27, проверка remote-browser на stage (пункт 15 плана по бэклогу)
area: backend
status: new
jira: не заведена
worth: "later"
---

# e2e допускают участника по приглашению без токена приглашения и получают гостя

## Что не так
Часть e2e берёт `inviteToken` из ответа `POST /api/rooms/:roomId/invites` и передаёт его в `POST /api/tokens/state`.
Такого поля в ответе нет: токен приходит только внутри `inviteLink` (параметр `invite`). В запрос уходит
`inviteToken: undefined`, и публичная комната пускает участника гостем, а не с ролью приглашения. Тесты проходят,
потому что роль host потом назначают админским `POST /api/rooms/:roomId/host/transfer`. Допуск по приглашению с
ролью эти тесты на самом деле не проверяют, хотя выглядят так, будто проверяют.

## Почему всплыло
Скрипт проверки remote-browser на stage повторил приём из `media-screen-reconciliation.spec.ts` и получил role=guest
с правами только room.join, audio.join, surface.view, markdown-board.view, notes.view. Room-state отклонил создание
объекта: `missing-permission` для `surface.create-object`. Когда токен взяли из `inviteLink`, допуск выдал роль host.

## Почему не сейчас
Сессия закрывала план по бэклогу и проверки на стенде; правка e2e в неё не входила.

## Что сделать
В четырёх местах брать токен из `inviteLink` (как `tests/e2e/identity-boundary.spec.ts` и
`tests/e2e/media-source-grants.spec.ts`) и проверить роль в ответе допуска. Затем решить, нужен ли ещё
`host/transfer` в `media-screen-reconciliation.spec.ts` или роль host достаточно дать приглашением. В
`meeting-tools.spec.ts:134` проверить, что коллега получает роль member, а не guest.

## Стоимость и эффект
Не оценено; правка ограничена тестами. Эффект — тесты проверяют допуск по приглашению с ролью, а не обходят его.

## Оценка актуальности
Подтверждено по коду: `sanitizeRoomInvite` в `apps/api/src/index.ts:1540` возвращает запись приглашения без токена и
`inviteLink`; ответ на stage 2026-10-27 содержит только `inviteLink`. Не проверено, меняет ли исправление поведение
`meeting-tools.spec.ts` (права member против guest).

## Ссылки
- `tests/e2e/media-screen-reconciliation.spec.ts:124`, `:299`, `:384` — допуск; `:142`, `:318`, `:401` — `host/transfer`
- `tests/e2e/meeting-tools.spec.ts:134` через `admitInvitation` из `tests/e2e/staging-identity.ts:46`
- `apps/api/src/index.ts:464` — `createInviteLink`, `:1540` — `sanitizeRoomInvite`, `:3415` — ответ создания приглашения
- `docs/backlog/2026-10-11-remote-browser-callback-surface.md` — проверка, в которой всплыло
