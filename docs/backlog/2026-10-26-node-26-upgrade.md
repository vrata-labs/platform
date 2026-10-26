---
name: node-26-upgrade
date: 2026-10-26
source: решение владельца 2026-10-26 «перевести Vrata на последний Node»
area: infra
status: new
priority: P1
jira: не заведена
---

# Платформа закреплена на Node 22, последняя линия — Node 26

## Что не так
Все сборки и проверки закреплены на Node 22:
- образы `apps/api/Dockerfile`, `apps/room-state/Dockerfile`, `apps/remote-browser/Dockerfile` — `node:22-bookworm-slim`;
- `actions/setup-node` с `node-version: 22` в `ci.yml` (четыре job), `staging-deploy.yml` (два), `staging-smoke.yml`,
  `staging-extended.yml`, `template-catalog.yml`, `rutube-canary.yml`, `seat-marker-checks.yml`;
- `@types/node` `^22.13.10`; `packageManager` `pnpm@10.0.0`; `engines` и `.nvmrc` нет.

Node 22 «Jod» — maintenance LTS до 30.04.2027. Node 26 становится Active LTS 28.10.2026 и поддерживается до
30.04.2029 (последняя линия по старой схеме; с Node 27 выпуск раз в год).

## Почему всплыло
Решение владельца 2026-10-26. Попутно: среда разработки по умолчанию уже на Node 26 (linuxbrew), а проекты требуют
22 — ночному исполнителю пришлось явно подставлять Node 22.

## Почему не сейчас
Node 26 становится LTS 28.10.2026. Переход меняет образы, CI и staging gate и проверяется на стенде под арендой —
это дневная работа, не ночная очередь (Dockerfile и `.github/` вне границ ночи).

## Что сделать
1. После 28.10 одним PR перевести закрепления на 26: Dockerfile (с digest), setup-node во всех workflow,
   `@types/node`, добавить `engines` и `.nvmrc` (как в портале), обновить `packageManager`.
2. Полный локальный набор (unit, integration, e2e) и CI; проверить нативные зависимости и Playwright на Node 26.
3. Staging gate под арендой `vrata-stage acquire platform`. Портал встраивает образы платформы (профиль `platform`):
   переход портала — после принятия платформы или вместе с ним.

## Стоимость и эффект
Не оценено; по PR на репозиторий плюс staging. Эффект — поддержка до 2029 года вместо апреля 2027-го.

## Ссылки
- `apps/*/Dockerfile`, `.github/workflows/*.yml`, `package.json`.
- Портал: `docs/backlog/2026-10-26-node-26-upgrade.md` в vrata-labs/portal.
- Расписание Node.js: https://nodejs.org/en/about/releases/, https://endoflife.date/nodejs
