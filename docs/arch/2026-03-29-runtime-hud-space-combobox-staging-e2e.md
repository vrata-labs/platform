# План: combobox выбора пространства в runtime HUD + auto e2e + staging publish

## Цель

Добавить в runtime web-режима combobox внутри `apps/runtime-web/index.html` блока `<aside class="hud">`, чтобы пользователь видел названия всех доступных комнат/пространств и мог переключаться между ними без ручного редактирования URL. Одновременно довести путь проверки до автоматических `e2e`: локально и после публикации на staging.

## Не-цель

- Не перестраивать `control-plane` и не переносить выбор пространства туда.
- Не вводить новый тип сущности для "пространства", если достаточно уже существующих `rooms`.
- Не менять room manifest несовместимым образом.
- Не делать production rollout; целевая автоматизация публикации ограничивается `staging`.
- Не строить сложный каталог/поиск/группировку комнат, если для первой версии хватает одного списка в combobox.

## Предпосылки и ограничения

- Точка входа runtime: `apps/runtime-web/src/main.ts`; текущий HUD описан в `apps/runtime-web/index.html` и стилизован в `apps/runtime-web/src/styles.css`.
- Уже есть backend endpoint списка комнат: `listRooms()` в `apps/control-plane/src/index.ts` ходит в `GET /api/rooms`; это самый простой кандидат для наполнения combobox без новой модели данных.
- Уже есть runtime boot через room manifest в `apps/runtime-web/src/index.ts`; переключение пространства реалистично делать через переход на `roomLink`/`/rooms/:roomId`, а не через hot-swap state внутри уже загруженной комнаты.
- Уже есть `Playwright`-покрытие в `tests/e2e/runtime.spec.ts`; его нужно расширить, а не заводить второй e2e stack.
- В репозитории есть CI только для lint/typecheck/build/test в `.github/workflows/ci.yml`; отдельного staging workflow пока нет, значит публикацию и staging e2e нужно явно добавить в план как отдельный pipeline.
- Из UX-ограничений: новый элемент не должен ломать текущие кнопки `Join Audio`, `Mute`, `Start Share`, `Stop Share` и должен помещаться в HUD на mobile.
- Для обратной совместимости при недоступности списка комнат runtime должен остаться рабочим в текущей комнате без hard fail.
- Selector должен показывать только комнаты, допустимые для текущего runtime-пользователя; если текущий `GET /api/rooms` слишком широкий по scope, его нельзя использовать в runtime без серверного ограничения видимости.
- Нужно сохранить guest-friendly поведение: selector в runtime не должен требовать admin token или зависеть от control-plane auth flow.

## Подход

Идти в две итерации:

1. Сначала добавить в runtime HUD простой selector на базе уже существующего списка комнат и переключение через навигацию в выбранную комнату.
2. Затем зафиксировать автоматическую проверку: локальные Playwright e2e для selector flow и отдельный staging workflow, который деплоит текущую ветку/сборку в staging и прогоняет staging e2e smoke после публикации.

## Задачи

### Iteration 1 - Runtime HUD selector

- [ ] Зафиксировать минимальный UX контракт: combobox виден только в обычном web runtime HUD, имеет label, показывает текущую комнату выбранной по умолчанию и не перекрывает существующие controls.
- [ ] Проверить, можно ли безопасно использовать существующий `GET /api/rooms` в runtime для guest/user flow; если нет, добавить узкий read-only endpoint списка доступных комнат для текущего runtime scope без admin-прав.
- [ ] Зафиксировать policy видимости: какие комнаты видит guest, какие видит пользователь внутри tenant scope, и что делать при отсутствии scope/auth.
- [ ] Определить формат данных для selector без новой сущности: использовать существующие `roomId`, `name`, `roomLink`, `templateId` из `GET /api/rooms`.
- [ ] Добавить в runtime клиент helper для получения списка комнат из API без дублирования логики control-plane.
- [ ] Обновить `apps/runtime-web/index.html`, добавив в `<aside class="hud">` блок selector с label и `select`/combobox.
- [ ] Обновить `apps/runtime-web/src/styles.css`, чтобы selector аккуратно вписывался в HUD на desktop и mobile и не ломал существующую верстку.
- [ ] Обновить `apps/runtime-web/src/main.ts`, чтобы при старте runtime selector загружал список доступных комнат, отображал текущую комнату выбранной и по change выполнял переход в выбранный `roomLink`.
- [ ] Добавить graceful fallback: если `GET /api/rooms` недоступен или вернул пустой список, selector скрывается или дизейблится с понятным статусом, а текущая комната продолжает работать.
- [ ] Зафиксировать UX тексты selector states: `loading`, `empty`, `unavailable`.
- [ ] Явно обработать edge cases: текущая комната отсутствует в списке, дублирующиеся названия, длинные названия, room list загрузился позже runtime boot.
- [ ] Зафиксировать отображение дублей: option label строится как `name + short roomId`, чтобы одинаковые названия оставались различимыми.

### Iteration 2 - Автоматические тесты и staging publish

- [ ] Добавить unit-тесты для runtime helper'а списка комнат: happy path, пустой список, HTTP error, mapping текущей комнаты в selected option.
- [ ] Расширить `tests/e2e/runtime.spec.ts` happy-path сценарием: HUD показывает selector, список содержит доступные комнаты, текущая комната выбрана по умолчанию.
- [ ] Добавить `e2e` сценарий переключения пространства: пользователь выбирает другую комнату в combobox, браузер переходит в новый room URL, runtime загружает manifest новой комнаты, HUD отражает новое название.
- [ ] Добавить негативный `e2e` сценарий: API списка комнат недоступен/ошибается, runtime не падает и базовый room flow остается usable.
- [ ] Обновить существующий CI workflow или добавить отдельный workflow для локального `Playwright` прогона после build/test, чтобы selector flow проверялся автоматически на PR.
- [ ] Зафиксировать минимальный staging automation contract: либо workflow сам деплоит артефакты на staging, либо принимает уже опубликованный `BASE_URL` и выполняет только post-deploy smoke; выбрать один вариант для v1.
- [ ] Спроектировать staging deployment workflow: build артефактов, публикация на staging, ожидание health endpoint, затем запуск Playwright smoke против staging base URL.
- [ ] Выделить staging e2e smoke набор отдельно от локальных e2e, чтобы на staging гонялись быстрые и детерминированные проверки selector flow и room boot, без тяжелых нестабильных сценариев.
- [ ] Зафиксировать проверяемый критерий ready для staging workflow: job зеленый только если deploy step успешен, staging `/health` отвечает `OK`, и staging smoke проходит полностью.
- [ ] Зафиксировать rollback для staging publish: если staging e2e красные, выкладка помечается как failed и новый runtime не считается принятой версией.

## Затронутые файлы/модули

- `apps/runtime-web/index.html`
- `apps/runtime-web/src/styles.css`
- `apps/runtime-web/src/main.ts`
- `apps/runtime-web/src/index.ts`
- `apps/runtime-web/src/*.test.ts`
- `tests/e2e/runtime.spec.ts`
- `playwright.config.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/*staging*.yml` или эквивалентный новый workflow
- `infra/yandex/cloud-init/staging-api.yaml` и/или `infra/yandex/cloud-init/staging-scenes.yaml`, если staging publish останется завязан на текущий VM bootstrap path
- `docs/status.md` или отдельная заметка по staging verification, если нужно зафиксировать новый pipeline

## Тест-план

- **Unit**
- [ ] Runtime helper списка комнат корректно парсит `GET /api/rooms`.
- [ ] Выбор текущей комнаты правильно вычисляется по `roomId`/URL.
- [ ] Ошибка загрузки списка комнат переводит selector в fallback state без throw в boot path.

- **Integration**
- [ ] Runtime HUD корректно рендерит selector после boot без поломки существующих controls.
- [ ] Selector change инициирует переход именно в выбранный `roomLink`, а не пытается частично переиспользовать старый manifest/state.
- [ ] При пустом списке или отсутствии текущей комнаты в payload UI остается согласованным и комната работает дальше.
- [ ] Guest/runtime flow работает без admin token и без зависимости от `control-plane` auth.

- **E2E local**
- [ ] В `demo-room` виден combobox со списком доступных комнат.
- [ ] Текущая комната выбрана по умолчанию.
- [ ] Переключение на другую тестовую комнату меняет URL и приводит к успешной загрузке нового runtime.
- [ ] При ошибке endpoint списка комнат пользователь все еще видит текущую комнату и базовый room shell остается usable.

- **E2E staging**
- [ ] После staging publish smoke открывает staging room URL и проверяет наличие combobox в HUD.
- [ ] Smoke подтверждает, что selector показывает хотя бы две комнаты/пространства тестового стенда.
- [ ] Smoke переключает комнату и подтверждает загрузку нового room shell по staging URL.
- [ ] Smoke завершает прогон только после успешного ответа staging health endpoint и room page load.
- [ ] Smoke выполняется по выбранному для v1 contract: full deploy+smoke или post-deploy smoke по переданному `BASE_URL`.

- **Негативные кейсы**
- [ ] `GET /api/rooms` вернул `500`.
- [ ] `GET /api/rooms` вернул пустой список.
- [ ] Текущая комната отсутствует среди доступных.
- [ ] В списке есть одинаковые `name`; UI остается различимым хотя бы через `name + roomId`.
- [ ] Длинные названия не ломают layout HUD на mobile.
- [ ] Guest-пользователь без control-plane контекста все еще видит допустимый selector state и может остаться в текущей комнате.

## Риски и откаты (roll-back)

- Риск: прямое использование `GET /api/rooms` в runtime раскроет больше комнат, чем ожидается для конечного пользователя.
  - Откат: ограничить selector текущим tenant/scope или временно feature-flag'ом выключить selector до появления более узкого endpoint.
- Риск: selector не сможет работать в guest flow без отдельного scope-aware endpoint.
  - Откат: для v1 оставить selector выключенным для guest mode через feature flag или вернуть только текущую комнату, пока не появится безопасный read-only endpoint.
- Риск: selector перегрузит HUD и ухудшит mobile UX.
  - Откат: свернуть блок в компактный layout, оставить только label + select, при необходимости скрыть второстепенные help-тексты.
- Риск: попытка переключать пространство без полной навигации приведет к частично сломанному runtime state.
  - Откат: держать v1 только на полном переходе в новый `roomLink`.
- Риск: staging deploy automation окажется завязана на внешний ручной шаг вне репозитория.
  - Откат: зафиксировать минимально полезный вариант — workflow, который после деплоя в staging запускает e2e smoke по переданному `BASE_URL`; сам deploy при необходимости оставить отдельным явным job/script.
- Риск: staging e2e будут нестабильными из-за долгой загрузки сцены/инфры.
  - Откат: держать отдельный короткий smoke-набор, явные health checks и увеличенные, но фиксированные таймауты только для staging.

## Definition of done для этого плана

- [ ] В `apps/runtime-web` внутри HUD появился рабочий combobox выбора комнаты/пространства.
- [ ] Selector показывает названия всех доступных комнат и корректно отмечает текущую.
- [ ] Selector показывает только комнаты, разрешенные для текущего runtime scope, без admin token.
- [ ] Переключение пространства работает через переход в выбранную комнату и не ломает текущий join flow.
- [ ] Есть unit/integration/e2e покрытие локального selector flow.
- [ ] Есть зафиксированный и реализованный staging automation contract для v1: full deploy+smoke или post-deploy smoke.
- [ ] Есть автоматический staging publish path и staging e2e smoke после публикации.
- [ ] При сбое списка комнат runtime остается usable хотя бы для текущей комнаты.
