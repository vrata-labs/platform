# План: XR/VR debug restart context

## Цель

Зафиксировать текущее состояние XR/VR проблемы, уже подтверждённые факты, рабочие/нерабочие гипотезы и реалистичный план добивки device-specific WebXR path в новой чистой сессии.

## Не-цель

- Не переписывать avatar/seating subsystem заново.
- Не возвращаться к web-path regressions, которые уже доведены до рабочего состояния.
- Не смешивать Hall scene-specific баги с общей XR input/ray логикой.
- Не полагаться на `avatarvrmock` как на единственный источник правды для реального XR поведения устройства.

## Предпосылки и ограничения

- Текущая рабочая ветка: `deploy/scene-bundles-stage-20260328`.
- Staging app URL: `https://89.169.161.91.sslip.io`.
- Основные комнаты для проверки:
- `Hall`: `42db8225-f671-4e46-9c28-9381d66a948c`
- `BlueOffice`: `0b537d34-7b92-4b51-854a-8c64cfb4c114`
- Web path уже в целом рабочий:
- seat markers видны,
- click path в web исправлялся и доводился отдельно,
- turn-then-release teleport suppression тоже делалась отдельно.
- Hall остаётся ненадёжной XR-диагностической комнатой:
- несколько раз наблюдались `sceneBundleState: fallback` / странное `Connecting...`,
- в VR там отдельно всплывал баг с огромной высотой view,
- поэтому основной XR debug сейчас нужно вести через `BlueOffice`.
- На staging уже есть XR debug/telemetry plumbing:
- XR HUD в runtime,
- `/api/rooms/:roomId/xr-telemetry` admin endpoint,
- event-first telemetry history,
- synthetic XR test hook `__NOAH_TEST__.setSyntheticXrState(...)`.
- Важное организационное ограничение: `Staging Deploy` workflow часто падал не из-за кода, а из-за запуска с short SHA вместо exact remote SHA. Для deploy нужно использовать exact SHA из `git ls-remote origin deploy/scene-bundles-stage-20260328`.

## Подход

Продолжать не через blind fixes и не через ручные описания с устройства, а через два параллельных канала:

1. `Synthetic XR on live staging`
   Этот path уже подтверждает, что core XR logic (`ray -> turn -> trigger -> seat`) работает на стенде.

2. `Real device telemetry on BlueOffice`
   Через `/xr-telemetry` сравнивать реальное устройство с synthetic path и править только расхождение между ними.

## Что уже установлено как факт

### 1. Core XR path на стенде жив

- Synthetic XR self-check на live staging уже проходил:
- луч активируется,
- yaw меняется,
- trigger сажает на `blueoffice-seat-a`.

Следствие:
- Remaining bug не в общей XR core logic, а в device-specific real WebXR input/pose path.

### 2. Луч по origin уже почти/полностью доведён

- После нескольких итераций telemetry показала, что `Ray origin` можно привести близко к controller path.
- Последние изменения шли в сторону `rightController` / `rightControllerWorld`, а не `rightGrip/rightResolved`.

### 3. Главный remaining bug сузился до real-device turn/input path

- На реальном устройстве долгое время telemetry показывала только vertical input (`turnY ~ -1`, `turnX = 0`).
- Потом raw horizontal signal начал появляться в telemetry, но `snapTurnFired` не срабатывал из-за слишком высокого threshold.
- Threshold уже был снижен до `0.2` и right-stick mapping уже переводился на raw axes.

### 4. `avatarvrmock` как единственный XR oracle недостоверен

- Fresh/canonical rooms под `avatarvrmock=1` могли уходить в `fallback` и не давать честный real-device XR path.
- Поэтому mock-VR tests по Hall/observer уже переводились в `fixme`, чтобы не шуметь в staging gate.

## Задачи (чек-лист)

### A. Зафиксировать baseline перед новой итерацией

- [ ] Проверить current `git status` и `git log -8 --oneline`.
- [ ] Проверить exact current remote head через `git ls-remote origin deploy/scene-bundles-stage-20260328`.
- [ ] Убедиться, что `pnpm test:e2e:staging` снова зелёный или отличается только на осознанных `fixme`/`skipped` тестах.

### B. Подтвердить, что latest XR instrumentation реально на staging

- [ ] Открыть canonical `BlueOffice` room на staging и через Playwright проверить наличие `__NOAH_TEST__.setSyntheticXrState`.
- [ ] Проверить, что synthetic XR self-check всё ещё проходит на live staging после последнего deploy.
- [ ] Не двигаться дальше, пока synthetic XR path на текущем build не подтверждён.

### C. Снять и разобрать fresh real-device telemetry именно на `BlueOffice`

- [ ] Снять `/api/rooms/0b537d34-7b92-4b51-854a-8c64cfb4c114/xr-telemetry` после нового short repro.
- [ ] Отделить реального участника от synthetic participants по `xrAvatarDebug.profile` и `xrRawInputs[].profiles`.
- [ ] Извлечь только meaningful history rows:
- `ray_on`
- `ray_off`
- `trigger_press`
- `snap_turn`
- seat transitions
- кадры с ненулевыми `xrAxes`/raw axes/buttons.

### D. Добить real-device turn path

- [ ] Сравнить `xrTurnCandidates.rightPrimary*` vs `rightSecondary*` vs `mappedTurnX/turnY` на реальном устройстве.
- [ ] Подтвердить, какая raw axis pair реально двигается при реальном `right stick left/right`.
- [ ] Если `mappedTurnX` снова остаётся `0`, расширить mapping на доминантную пару осей по реальному input source.
- [ ] Если `mappedTurnX` уже ненулевой, но `snapTurnFired=false`, проверить threshold/cooldown path по `playerYaw` и `kinds[]`.
- [ ] Подтвердить следующий repro telemetry, что `playerYaw` реально меняется одновременно с turn gesture.

### E. Добить real-device ray path только если telemetry покажет расхождение

- [ ] Сравнить `Ray origin` с `rightControllerWorld` и `rightHandWorld`.
- [ ] Если `Ray origin` уже совпадает с `rightControllerWorld`, origin больше не трогать.
- [ ] Проверить `Ray direction` относительно real device repro; если поведение всё ещё “луч виден только в части пространства”, сравнить raw `targetRaySpace` direction path против current world transform path.

### F. Вернуться к Hall отдельно, только после стабилизации `BlueOffice`

- [ ] Отдельно подтвердить, что Hall height bug и scene fallback не мешают базовой XR logic, уже стабилизированной в `BlueOffice`.
- [ ] Hall-specific bug вести отдельным треком, не смешивая его с общим XR input/ray fix.

## Затронутые файлы/модули (если известно)

- `apps/runtime-web/src/main.ts`
- `apps/runtime-web/src/avatar/avatar-xr-input.ts`
- `apps/runtime-web/src/avatar/avatar-xr-hands.ts`
- `apps/runtime-web/src/avatar/avatar-xr-ray.ts`
- `apps/runtime-web/src/movement.ts`
- `apps/runtime-web/index.html`
- `apps/api/src/index.ts`
- `apps/api/src/index.test.ts`
- `tests/e2e/runtime-staging.spec.ts`
- `docs/plans/2026-04-24-xr-vr-debug-restart-context.md`

## Тест-план

### Unit

- [ ] `avatar-xr-input.test.ts`: right-stick mapping на real raw axes pairs.
- [ ] `avatar-xr-ray.test.ts`: world-space pose/direction conversion без лишнего yaw.
- [ ] `movement.test.ts`: `applySnapTurn()` на реальном threshold сигнале.
- [ ] `api/index.test.ts`: XR telemetry endpoint хранит history, а не только latest snapshot.

### Integration

- [ ] Synthetic XR self-check against live staging должен подтверждать:
- ray on,
- yaw change,
- trigger seat claim.
- [ ] XR telemetry history должна содержать meaningful events, а не idle noise.

### E2E / Staging

- [ ] `pnpm test:e2e:staging` должен быть зелёным или иметь только осознанные `fixme/skipped` mock-VR cases.
- [ ] Synthetic XR staging regression на `BlueOffice` должен проходить на live staging.
- [ ] После каждого XR fix повторно снимать real-device telemetry history и подтверждать, что изменилось именно то поле, ради которого делался fix.

### Негативные кейсы

- [ ] Device reports only vertical axis and never horizontal.
- [ ] Device reports horizontal on unexpected pair (`axes[0/1]` instead of `axes[2/3]`).
- [ ] `selectstart` не приходит, но `button0Pressed` приходит.
- [ ] `avatarvrmock` снова уходит в `fallback` и не может считаться источником истины.
- [ ] Staging deploy again fails due short SHA or post-verify workflow quirks.

## Риски и откаты (roll-back)

- Риск: снова перепутать local head, remote head и реально выкаченный staging SHA.
  - Откат: перед каждым deploy проверять `git ls-remote origin deploy/scene-bundles-stage-20260328` и использовать exact SHA.

- Риск: mock-VR tests снова начнут rollback-ить staging после успешного verification gate.
  - Откат: оставлять недостоверные mock-VR cases в `fixme`, пока synthetic/live proof path не станет стабильным.

- Риск: telemetry history опять будет забиваться idle noise.
  - Откат: хранить в `history` только event-first meaningful XR rows, а `latest` использовать как heartbeat.

- Риск: synthetic XR path будет green, а real device path останется broken.
  - Откат: трактовать synthetic self-check только как proof of core logic, а real device telemetry как отдельный источник правды для device-specific mapping.

- Риск: Hall продолжит мешать диагностике из-за scene-specific fallback/height bug.
  - Откат: использовать `BlueOffice` как primary XR diagnostic room, Hall держать отдельным scene-specific follow-up.
