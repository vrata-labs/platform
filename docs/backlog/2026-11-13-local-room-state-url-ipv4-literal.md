---
name: local-room-state-url-ipv4-literal
date: 2026-11-13
source: T17, ручная проба посадки 2026-11-10…13
area: infra
status: new
priority: P3
jira: не заведена
worth: "later"
---

# Локальная среда отдаёт браузеру адрес room-state 127.0.0.1, недоступный из Windows при WSL mirrored

## Что не так
Локальные запуски, где Node-сервисы слушают адрес по умолчанию (IPv6 wildcard, dual-stack), выдают браузеру публичный URL room-state с IPv4-литералом 127.0.0.1. Браузер в Windows при WSL `networkingMode=mirrored` не достигает такого слушателя по 127.0.0.1 (connection refused), хотя по `localhost` (::1) достигает. Комната загружается, но room-state не подключается, и посадка недоступна: клик по креслу заканчивается статусом Seating unavailable.

## Почему всплыло
В ручной пробе T17 из Windows-браузера посадка не работала. HAR показал три WebSocket к ws://127.0.0.1 без ответа сервера. Проверка штатным Windows curl.exe: слушатель `[::]` недоступен по 127.0.0.1 и доступен по localhost; слушатели на 0.0.0.0 и 127.0.0.1 доступны по обоим адресам. После выдачи room-state по `ws://localhost` посадка у пользователя заработала.

## Почему не сейчас
Автотесты внутри Linux это не затрагивает, продукт на стенде и в self-host использует свои адреса. Затронуты только ручные проверки локальной среды из Windows.

## Что сделать
Решить, какой адрес по умолчанию отдавать браузеру в локальных запусках (localhost или явная IPv4-привязка слушателей), и проверить запуск из Windows-браузера при WSL mirrored. Отдельно подтвердить, что Docker-конфигурации self-host и demo-local, где 127.0.0.1 тоже встречается, публикуют IPv4-слушатель и не имеют этой проблемы: из Windows они не проверялись.

## Стоимость и эффект
Не оценено. Затрагивает разработчиков и проверяющих, которые открывают локальный стенд из Windows при WSL mirrored.

## Оценка актуальности
Причина подтверждена экспериментом и ручной проверкой 13.11. Docker-варианты не проверены.

## Ссылки
- `playwright.config.ts:13`
- `tests/e2e/reference-template-fixture.ts:76`
- `apps/api/src/public-endpoints.ts:34`
- `.env.example:27` — уже localhost
- `infra/docker/.env.selfhost.example:9`, `infra/docker/.env.staging.example:15`, `docs/demo/README.md:23` — 127.0.0.1 при публикации портов Docker
- `docs/reviews/2026-11-05-t17-acceptance-decisions.md` — D-105
