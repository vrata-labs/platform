---
name: identity-boundary-personal-owner-cold-start
date: 2026-10-26
source: T01a S3b, CI и локальные повторы
area: e2e
status: parked
priority: P3
jira: не заведена
---

# identity-boundary: первая загрузка комнаты иногда ждёт 90 секунд

## Что не так

Тест «v2 personal owner persists across reload and a copied public ID cannot reopen the room»
(tests/e2e/identity-boundary.spec.ts:178) изредка падает по таймауту 90 секунд. Зависает первый шаг после
raise(2): page.goto на /rooms/demo-room не получает domcontentloaded, в конце ERR_ABORTED.

## Почему всплыло

CI 40197614452 (attempt 1) и CI 40319756970 (attempt 1); локально 1 из 10 повторов при load ~25 —
упал первый повтор серии (холодный старт фикстуры), остальные прошли за 15–30 секунд. При load ~6
15 из 15 по 6–7 секунд. Зонд pg_stat_activity при зелёной серии ожиданий блокировок не показал.

## Почему не сейчас

Не воспроизводится детерминированно; main и ветки в остальных прогонах CI зелёные. Кодовую причину
не нашли: возможна конкуренция за глобальную advisory-блокировку инициализации хранилища
(vrata:postgres-storage-init:v1) или холодная отдача runtime под нагрузкой.

## Что сделать

Сохранять журнал API фикстуры при падении (сейчас он держится только в памяти, reference-template-fixture.ts),
снять pg_stat_activity и длительность ответа /rooms/demo-room в момент зависания.

## Ссылки

- tests/e2e/identity-boundary.spec.ts:178
- tests/e2e/reference-template-fixture.ts — запуск API, журнал в памяти.
- apps/api/src/storage-postgres-init.ts — advisory-блокировка инициализации.
