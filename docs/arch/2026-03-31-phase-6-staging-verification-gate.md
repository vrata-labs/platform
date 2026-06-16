# План: Phase 6 — staging verification как обязательный gate

## Цель

Сделать staging deploy для `noah` по-настоящему gate-driven: после rollout на staging GitHub Actions должен автоматически запускать `pnpm test:e2e:staging`, проверять обязательные staging flows и считать deploy успешным только если post-deploy smoke и staging verification зеленые; при fail workflow должен помечать deploy неуспешным и выполнять rollback на previous successful SHA.

## Не-цель

- Не делать production verification/deploy.
- Не расширять продуктовую логику runtime/control-plane/storage beyond того, что нужно для надежного staging gate.
- Не строить отдельную сложную orchestration систему из нескольких environments/promotions.
- Не заменять текущий registry-based deploy contract; Phase 6 работает поверх уже внедренной Phase 5 схемы.

## Предпосылки и ограничения

- Phase 5 завершена: staging deploy уже идет из registry images по immutable SHA, есть рабочий workflow `.github/workflows/staging-deploy.yml`, verified `workflow_dispatch` run и проверенный rollback по previous SHA.
- Есть существующий staging smoke workflow `.github/workflows/staging-smoke.yml` и staging Playwright suite `tests/e2e/runtime-staging.spec.ts`.
- Staging e2e уже ходят по public HTTPS URL и покрывают selector flow + весь восстановленный scene catalog.
- Текущий staging host: `https://89.169.161.91.sslip.io`.
- Для rollback workflow нужен previous successful SHA; его нужно хранить/обновлять предсказуемо и не путать с alias tags.
- Жесткий gate должен жить прямо в `Staging Deploy`, а не в side workflow, чтобы deploy без verification не считался успешным.

## Подход

Расширить `.github/workflows/staging-deploy.yml` так, чтобы после rollout и базового smoke он запускал staging Playwright suite на публичном HTTPS URL. Mandatory gate использует текущий стабилизированный staging suite и не должен автоматически расширяться flaky/manual-only checks без отдельного решения. Если smoke или `pnpm test:e2e:staging` падают, workflow выполняет rollback на previous successful SHA, повторно проверяет минимальный smoke и завершает job как failed. Источник previous successful SHA должен быть простым и устойчивым: сохраняемый deploy state на VM и/или workflow input/output, без дополнительной внешней БД.

В реализации нужно оставить mandatory gate минимально детерминированным: текущий staging suite плюс already-stabilized scene checks, без автоматического добавления дополнительных manual/test-only rooms.

## Задачи

### 1. Зафиксировать gate contract

- [x] Зафиксировать список staging checks, которые обязательны всегда после deploy: `/health`, `demo-room`, `control-plane`, `pnpm test:e2e:staging`.
- [x] Зафиксировать, какие staging tests остаются частью mandatory gate, а какие могут быть manual-only в будущем.
- [x] Зафиксировать rollback trigger: любой fail post-deploy smoke или `pnpm test:e2e:staging`.
- [x] Зафиксировать источник previous successful SHA для rollback.

### 2. Интегрировать staging e2e в deploy workflow

- [x] Обновить `.github/workflows/staging-deploy.yml`, чтобы после rollout выполнялся Playwright-based `pnpm test:e2e:staging`.
- [x] Передавать в workflow нужные env vars для staging suite (`BASE_URL`, scene room ids, admin token при необходимости).
- [x] Убедиться, что staging suite использует public HTTPS path, а не direct IP fallback.
- [x] Сделать verification steps blocking для успешного deploy status.

### 3. Упростить/встроить existing staging smoke path

- [x] Решить, остается ли `.github/workflows/staging-smoke.yml` как manual utility workflow, или его логика полностью переезжает в `staging-deploy.yml`.
- [x] Убрать дублирование wait/health logic между workflow'ами.
- [x] Зафиксировать один source of truth для staging verification contract.

### 4. Реализовать rollback on failed verification

- [x] Добавить в deploy workflow rollback step, который выполняется при fail verification.
- [x] Rollback должен повторно rollout'ить previous successful SHA без rebuild на VM.
- [x] После rollback выполнять минимальный smoke: `/health`, `demo-room`, `control-plane`.
- [x] Даже после успешного rollback исходный failed deploy должен оставаться failed в GitHub Actions.

### 5. Зафиксировать successful deploy state

- [x] Добавить простой механизм сохранения current successful SHA для следующего rollback.
- [x] Зафиксировать, где хранится этот state: файл на VM, env file, workflow artifact или другой простой persistent path.
- [x] Убедиться, что rollback не опирается на alias tags вроде `staging`.
- [x] Явно записывать current successful SHA и rollback target в workflow logs/summary для отладки.

### 6. Обновить документацию

- [x] Обновить `README.md` с новым gate-driven staging deploy contract.
- [x] Обновить `docs/deployment-yandex-cloud.md` с описанием auto verification и rollback behavior.
- [x] Обновить `AGENTS.md`, если появятся важные operational lessons по gate/rollback behavior.

## Затронутые файлы/модули

- `.github/workflows/staging-deploy.yml`
- `.github/workflows/staging-smoke.yml`
- `tests/e2e/runtime-staging.spec.ts`
- `infra/docker/rollout-staging-images.sh`
- `README.md`
- `docs/deployment-yandex-cloud.md`
- `AGENTS.md`

## Тест-план

- **Workflow path**
- [x] `Staging Deploy` выполняет rollout, smoke и `pnpm test:e2e:staging` в одном workflow.
- [x] Successful deploy остается green только если все checks прошли.

- **Verification gate**
- [x] После deploy `https://89.169.161.91.sslip.io/health` отвечает `200`.
- [x] После deploy `https://89.169.161.91.sslip.io/rooms/demo-room` отвечает `200`.
- [x] После deploy `https://89.169.161.91.sslip.io/control-plane` отвечает `200`.
- [x] `pnpm test:e2e:staging` проходит на public HTTPS base URL.

- **Rollback**
- [x] Если verification intentionally fails, workflow выполняет rollback на previous successful SHA.
- [x] После rollback минимальный smoke снова зеленый.
- [x] Failed rollout остается failed в GitHub Actions history, even if rollback succeeded.

- **Негативные кейсы**
- [x] При сломанном staging e2e gate deploy job fail-fast уходит в rollback.
- [x] При отсутствии previous successful SHA workflow падает явной ошибкой rollback_precondition_failed.
- [x] При неудачном rollback workflow дает явный failed status и не маскирует проблему.
- [x] Rollback не удаляет `postgres`/`minio` volumes.

## Риски и откаты (roll-back)

- Риск: staging e2e сделают deploy слишком долгим и flaky.
  - Откат: разделять mandatory checks и heavier optional checks, но mandatory gate должен оставаться deterministic.
- Риск: rollback logic станет слишком сложной из-за хранения previous SHA.
  - Откат: использовать максимально простой persistent state, например файл на staging VM.
- Риск: flaky scene checks будут часто откатывать рабочий deploy.
  - Откат: держать в mandatory gate только уже стабилизированные staging tests; остальное оставлять manual-only или advisory.
- Риск: workflow станет трудно отлаживать после rollback.
  - Откат: всегда сохранять явные logs/status для failed deploy и отдельный лог rollback path.

## Definition of done для Phase 6

- [x] `Staging Deploy` включает обязательный post-deploy gate с `pnpm test:e2e:staging`.
- [x] Deploy считается успешным только если smoke и staging e2e зеленые.
- [x] При fail verification workflow автоматически откатывает previous successful SHA.
- [x] Rollback path проверен реальным failed rollout scenario.
- [x] Gate/rollback contract задокументирован в проекте.

## Итог выполнения

- Phase 6 завершена: `Staging Deploy` стал обязательным gate-driven workflow, который делает rollout, public smoke, `pnpm test:e2e:staging`, сохраняет successful SHA и откатывает previous successful SHA при fail verification.
- Verified failed rollout scenario: workflow run `23804157870` специально провалил gate и выполнил rollback на сохраненный successful SHA.
- Verified successful gated deploy: workflow run `23804311484` выполнил rollout и полный staging gate без rollback.
- `.github/workflows/staging-smoke.yml` остается manual utility workflow, но source of truth для mandatory staging verification теперь `.github/workflows/staging-deploy.yml`.
