---
name: voice-join-gives-up-after-ice-failure
date: 2026-10-26
source: Staging Deploy 40340484411 (attempt 2), журнал LiveKit стенда 15:10–15:11Z
area: frontend
status: new
priority: P2
jira: не заведена
---

# Вход в голос сдаётся после неудачного ICE и не пробует другой путь

## Что не так

Если ICE медиасоединения не устанавливается, клиент примерно через 17 секунд закрывает сигнал (`SIGNAL_SOURCE_CLOSE`) и возвращает кнопку «Join Audio». Повторов через TCP 7881 или TURN relay нет, и сам runtime не переподключается. Пользователь с ненадёжным UDP остаётся без звука, пока не нажмёт кнопку снова.

## Почему всплыло

В gate нестабильно падал тест «reference meeting synchronizes only declared surfaces across two participants»: на свежем стенде 111.88.217.54 он упал в двух попытках из трёх. Журнал LiveKit за окно падения:
- хост подключился только через TURN (`connectionType: turn`) за 6 с;
- у наблюдателя единственная пара ICE в состоянии `failed`: LiveKit отправил 8 STUN-проверок на srflx-адрес раннера и не получил ответа, от клиента не пришло ни одной проверки, relay-кандидата не было.

Конфигурация стенда при этом верна: node IP, ufw для 7881/tcp, 7882/udp, 3478/udp и диапазона relay. Тест перенесён в Staging Extended.

## Почему не сейчас

Это поведение продукта, а не стенда или gate. Нужна отдельная правка media-подключения runtime со своими тестами.

## Что сделать

Найти, где runtime обрабатывает неудачное подключение к комнате LiveKit (`apps/runtime-web/src/main.ts`, `apps/runtime-web/src/media/media-participant.ts`). Выяснить, какие таймауты и политика ICE передаются клиенту. Проверить, пробует ли клиент TCP и relay при недоступном UDP, и воспроизвести это локально с заблокированным UDP 7882.

## Стоимость и эффект

Не оценено. Затрагивает всех, у кого ненадёжный UDP до LiveKit; после исправления тест можно вернуть в gate.

## Ссылки

- `tests/e2e/reference-template-scenarios.ts` — сценарий двухстороннего звука.
- `.github/workflows/staging-extended.yml`.
