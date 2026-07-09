# Plan: VR Ray, Teleport, Seating, Snap-Turn Fix

**Path**: `docs/plans/2026-04-23-vr-ray-teleport-seating-snapturn-fix-v1.md`

## Цель

VR happy path стабильно работает: луч, телепорт, посадка (seating), snap-turn. Web (desktop + mobile) не деградирует.

### Не-цель

- Расширенный parity VR/web (только сохранение рабочего web flow).
- Новые XR-фичи (только починка текущего).
- Полировка UX за пределами stability.

## Предпосылки и ограничения

- VR-таргет: **Quest Browser** с типовыми контроллерами (dual Analog).
- Web должен продолжать работать: mouse/cursor + keyboard (desktop), touch (mobile).
- Room-state reconnect уже используется в staging — seat restore должен корректно восстанавливаться.

## Подход

1. **Анализ** существующей логики в `main.ts` (строки ~2621-3005 отвечают за pointer/keyboard/touch, ~2234-2339 — за XR movement).
2. **Изоляция** VR-специфичных веток (`renderer.xr.isPresenting`) от общих.
3. **Фикс** выявленных багов в VR-ветке: ray, seating, snap-turn.
4. **Верификация** web flow не деградировал — локальные тесты + staging e2e.

## Задачи

### Phase 0: Анализ и изоляция проблем

- [ ] Гипотеза: `resolveXrInteractionRay` возвращает null без `targetRaySpace` — проверить fallback hierarchy
- [ ] Гипотеза: `applySnapTurn` срабатывает при `|turnX| > 0.2` — проверить threshold
- [ ] Гипотеза: `isXrRayVisibleFromStick` показывает луч при `turnY <= -0.75` — проверить latched (-0.45)
- [ ] Гипотеза: seated mode блокирует movement position — проверить в `updateMovement`
- [ ] Проверить seating flow: `claimSeatById`, `sendSeatClaim`, `onSeatClaimResult`, `applySeatAnchorToPlayer`
- [ ] Зафиксировать текущие unit-тесты, которые закрывают эти модули
- [ ] Определить минимальные missing coverage

### Phase 1: XR Ray Fix

- [ ] Исправить `resolveXrInteractionRay` если pose->player transform incorrect
- [ ] Проверить fallback hierarchy: right hand → tracked-pointer → first
- [ ] Обновить/добавить unit-тесты для avatar-xr-ray.ts если нужно
- [ ] Валидировать, что pointer/cursor path не затронут

### Phase 2: Seating Fix

- [ ] Проверить seat claim flow: pendingSeatId → sendSeatClaim → onSeatClaimResult → currentSeatId
- [ ] Исправить seated teleport exit: releaseCurrentSeatLocally → teleportToFloor
- [ ] Проверить seat reconnect restore (already fixme в runtime.spec.ts)
- [ ] Исправить edge case: multiple simultaneous claims race condition
- [ ] Добавить unit-тесты для avatar-seating.ts если нужно

### Phase 3: Snap-Turn Fix

- [ ] Гипотеза: `applySnapTurn` threshold 0.2, cooldown 0.28s, snap angle PI/6 — проверить константы
- [ ] Проверить yaw integration в updateMovement при seated mode
- [ ] Убедиться що seated mode НЕ применяет movement к player position (только rotation)
- [ ] Проверить что `xrTurnCooldown` декрементируется каждый кадр: `xrTurnCooldown = Math.max(0, xrTurnCooldown - delta)`
- [ ] Добавить/обновить unit-тесты movement.test.ts

### Phase 4: No-Controller Fallback

- [ ] Гипотеза: При `inputSources.length === 0` movement = 0, turn = 0 — проверить graceful degradation
- [ ] Гипотеза: При отсутствии gamepad — fallback к предыдущему известному input без краша
- [ ] Убедиться что avatar mode остается предыдущим (не падает в null/undefined)
- [ ] Acceptance: movement = 0, turn = 0, avatar mode = предыдущий (desktop fallback)

### Phase 5: Web Non-Regression

- [ ] Проверить pointer path: `pointerdown` → `pointermove` → `pointerup` → click без ложного teleport
- [ ] Проверить keyboard path: WASD/Arrow → movement; pointer drag-release не trigger teleport
- [ ] Проверить mobile touch path: touchmove → movement
- [ ] Запустить `pnpm test:e2e` локально — убедиться что seat/teleport/cursor flow живы

### Phase 6: Staging Verification

- [ ] Опубликовать на staging через CI (`pnpm build && git push`)
- [ ] Дождаться деплоя (~5 минут для compose staging) перед запуском tests
- [ ] Запустить `pnpm test:e2e:staging` — ключевые сценарии: Hall seat claim, teleport exit, snap-turn если возможно
- [ ] Проверить staging debug state: interactionRay, currentSeatId, locomotionMode

## Затронутые файлы/модули

| Файл | Зона ответственности |
|------|-------------------|
| `apps/runtime-web/src/main.ts` | main entry, VR/web branching, interaction loop |
| `apps/runtime-web/src/movement.ts` | snap turn, keyboard direction, world projection |
| `apps/runtime-web/src/avatar/avatar-xr-ray.ts` | XR ray from controller pose |
| `apps/runtime-web/src/avatar/avatar-seating.ts` | seat anchor mapping, player positioning |
| `apps/runtime-web/src/avatar/avatar-xr-input.ts` | inputSources → axes |
| `apps/runtime-web/src/avatar/avatar-interaction.ts` | ray → target (seat/floor) resolution |

## Тест-план

### Unit-тесты (локальные)

- `movement.test.ts`: applySnapTurn threshold/cooldown, keyboard → direction
- `avatar-xr-ray.test.ts`: pose → room transform
- `avatar-xr-input.test.ts`: inputSources → axes mapping
- `avatar-seating.test.ts`: seat anchor map, resolveLocalSeatId
- `avatar-interaction.test.ts`: seat priority over floor, floor fallback, max distance

### Integration (main.ts flows)

- Pointer/cursor click → teleport
- Pointer drag-release → no teleport (already covered in runtime-staging.spec.ts:678)
- Seat claim → seated → teleport exit → standing

### E2E (локальный + staging)

- `pnpm test:e2e`: avatar-enabled hall room supports interaction ray teleport, sit, switch and teleport exit
- `pnpm test:e2e:staging`: staging hall web drag-release does not trigger teleport click
- [fixme] staging fresh hall mock VR can target and claim a seat through XR interaction path

## Риски и откаты

### Known Risks

- **XR pose instability** — разные контроллеры дают разные pose structure → ray может уходить мимо target. Mitigation: валидация на staging с mock VR (`?avatarvrmock=1`).
- **Seat reconnect race** — when room-state reconnect happens during seat claim. Mitigation: проверять что reconnect не убивает pending claim.
- **Touch/mouse drag click** — mobile drag-release может unintentionally teleport. Mitigation: suppressPointerClick уже есть в `main.ts:2642`.

### Rollback

- Если VR flow сломался на staging: вернуться к предыдущему коммиту через `git revert` или переключить IMAGE_TAG на предыдущий стабильный SHA.
- Если web flow деградировал: откат тот же.

## Definition of Done

- [ ] XR ray стабильно показывает target при hold stick forward вниз
- [ ] Seating claim → seated работает через trigger press
- [ ] Teleport exit из seated работает (click floor / trigger floor)
- [ ] Snap-turn работает: stick left/right → +\- 30deg с cooldown
- [ ] При inputSources.length === 0: movement = 0, turn = 0, avatar mode не крашится (graceful fallback)
- [ ] Web cursor/touch/touchmove → teleport работает без regression
- [ ] Mobile touch → movement работает без regression
- [ ] `pnpm test:e2e` локально — зеленый
- [ ] `pnpm test:e2e:staging` — зеленый на staging

---

*Plan created: 2026-04-23*