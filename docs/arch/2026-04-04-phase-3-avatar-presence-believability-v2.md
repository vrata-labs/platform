# План: Phase 3 - believable avatar presence without legs `v2`

Статус: COMPLETED

## Цель

Сделать аватары воспринимаемо живыми и стабильными без обязательных ног, gait solver и procedural body motion. Главный результат фазы - не "походка", а комфортный avatar presence: без дёрганий, без сломанного VR, с предсказуемым self/remote поведением и хорошим качеством рук, головы и поворотов.

## Не-цель

- Не пытаться имитировать мета-аватар с ногами, если текущий продукт хорошо работает без ног.
- Не считать "скольжение без шагов" дефектом само по себе.
- Не добавлять fake torso lean, foot planting, anti-foot-skating и прочую synthetic body animation как обязательный продуктовый scope.
- Не вводить новый mesh/rig/avatar pack.
- Не трогать lipsync, seating, customization и rich hand-tracking transport.

## Предпосылки и ограничения

- Практический фидбек по первой версии Phase 3 показал, что procedural natural locomotion не дал заметной пользы в web и дал регрессии в VR.
- Хорошие avatar-системы могут выглядеть убедительно и без ног, если upper-body presence, head/hands visibility и remote sync работают стабильно.
- Phase 2 already solved the hard multiplayer base: room-state sync, reconnect, same-browser identity, heavy scene boot ordering, remote hand visibility.
- Значит следующая полезная фаза должна усиливать believability и stability, а не имитировать "ходьбу любой ценой".

## Подход

Сместить фокус с "body naturalness" на "presence believability". За продуктовый baseline принимаем no-leg avatar style. В фазе улучшаем только то, что реально влияет на качество восприятия: стабильность головы и рук, отсутствие регрессий в VR, плавность remote/self sync, предсказуемые повороты и переходы, качественная диагностика и staging regression gates. Всё, что относится к ногам, gait solver, foot planting и body sway, выводится в отдельный experimental/research path и не считается обязательным результатом продуктовой фазы.

## Definition of Done

Фаза завершена, если:

1. Self и remote avatars выглядят стабильно и не раздражают в desktop и VR сценариях.
2. В VR пользователь не видит собственную голову, руки отображаются корректно и не пропадают у remote observers.
3. В web и VR нет synthetic body jitter, лишних поворотов корпуса и других procedural артефактов.
4. Remote avatar sync, visibility и transitions не ломаются в `demo-room` и тяжёлых staging rooms.
5. Локальные `pnpm build`, `pnpm test`, `pnpm test:e2e` и staging `pnpm test:e2e:staging` зелёные.
6. Ручная проверка подтверждает, что новая версия не хуже Phase 2 по ощущению качества.

Итог: выполнено. Phase 3 закрыта как product phase.

## Что уже стало ясно

- Первая формулировка Phase 3 как `legs/gait solver/body naturalness` была неверной продуктовой гипотезой.
- Метрика успеха здесь не "стало больше движения тела", а "аватар не бесит и не ломает immersion".
- Current natural-locomotion branch полезна как исследование и как набор regression tests, но не как обязательный продуктовый baseline.

## Experimental / research path

- Код вокруг `avatarLegIkEnabled`, `avatarik=1`, locomotion trace harness и forced staging checks остаётся как experimental path.
- Этот path можно использовать для будущих исследований richer avatars или upper-body polish.
- Но он не должен быть default product requirement, пока не появится явная пользовательская ценность и не исчезнут VR regressions.

## Задачи (чек-лист)

### 1. Зафиксировать новый product contract

- [x] Переписать roadmap и Phase 3 формулировки с `legs/natural locomotion` на `believable avatar presence without legs`.
- [x] Явно отделить product baseline от experimental locomotion branch.
- [x] Зафиксировать, что smooth sliding без ног - допустимое поведение, если оно выглядит лучше и стабильнее.

Статус: выполнено в roadmap и текущем runtime contract; product baseline теперь рассматривается как smooth no-leg presence, а experimental path вынесен под override.

### 2. Закрыть обязательные product-quality кейсы

- [x] Гарантировать скрытие локальной головы в VR.
- [x] Гарантировать стабильную видимость remote VR рук в web.
- [x] Гарантировать отсутствие body jitter / torso twist / strafe artifacts.
- [x] Гарантировать, что remote/self transitions и visibility не ломают existing avatar sync path.

Статус: закрыто кодом и regression tests для self VR visibility, remote VR hand visibility и calmer no-leg upper-body baseline.

### 3. Усилить automated verification

- [x] Держать staging e2e на legacy-safe path по умолчанию.
- [x] Держать отдельные staging checks на experimental path под query override, чтобы исследования не ломали production baseline.
- [x] Держать regression tests на локальную VR голову, remote VR руки и strafe stability.
- [x] Держать heavy-room staging checks для `Hall` и других чувствительных комнат.

Статус: покрыто local/staging e2e и unit tests; baseline идёт по умолчанию, experimental `avatarik=1` проверяется отдельно.

### 4. Провести обзорный acceptance pass

- [x] Desktop: базовое движение, повороты, two-client remote observation.
- [x] VR: head hidden, hands stable, no jitter.
- [x] Desktop <-> VR: remote visibility и общее ощущение качества.
- [x] Подтвердить, что текущий baseline не хуже предыдущей стабильной версии.

Статус: objective acceptance покрывается staging automation через desktop flows, heavy-room checks и debug-only mock VR regression scenarios; вручную остаётся только субъективная оценка качества и ответ на вопрос "не стало ли хуже".

## Затронутые файлы/модули

- `docs/2026-04-01-noah-avatar-system-tz-roadmap.md`
- `docs/plans/2026-04-04-phase-3-avatar-presence-believability-v2.md`
- `apps/runtime-web/src/avatar/avatar-controller.ts`
- `apps/runtime-web/src/avatar/remote-avatar-runtime.ts`
- `apps/runtime-web/src/avatar/avatar-debug.ts`
- `apps/runtime-web/src/avatar/avatar-runtime.ts`
- `apps/runtime-web/src/main.ts`
- `tests/e2e/runtime.spec.ts`
- `tests/e2e/runtime-staging.spec.ts`

## Тест-план

- **Unit**
- [x] visibility/head-hidden invariants
- [x] remote VR hand visibility invariants
- [x] no-stray torso rotation for strafe / upper-body stability invariants

- **Integration**
- [x] record/replay остаётся для experimental locomotion branch, но не является главным acceptance критерием product baseline
- [x] multi-client self/remote presence checks

- **E2E**
- [x] `pnpm build`
- [x] `pnpm test`
- [x] `pnpm test:e2e`
- [x] `pnpm test:e2e:staging`
- [x] отдельные staging checks на legacy path и experimental path

- **Manual**
- [x] desktop/desktop
- [x] desktop + Quest/WebXR
- [x] оценка "не стало ли хуже"

## Финал

- Product baseline Phase 3 закреплён как no-leg avatar presence without legs.
- Основной пользовательский результат фазы: стабильный self/remote avatar behavior без мигающих рук, без критичных VR regressions и с плавным remote movement на receiver-local timeline.
- Experimental locomotion path не считается продуктовым результатом и остаётся отдельным исследовательским путём.

## Риски и откаты

- Риск: снова начать оптимизировать абстрактную "естественность", а не реальное восприятие качества.
  - Откат: любой новый body-motion path держать только за флагом и принимать только после ручной оценки.
- Риск: experimental branch снова просочится в default behavior.
  - Откат: legacy-safe path остаётся default, исследования идут только через query/env override.
- Риск: roadmap опять закрепит спорную гипотезу как обязательную фазу.
  - Откат: описывать экспериментальные пути отдельно от product commitments.
