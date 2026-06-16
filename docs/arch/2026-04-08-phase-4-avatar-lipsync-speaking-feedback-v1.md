# План: Phase 4 - avatar lipsync, speaking feedback и expressive polish `v1`

Статус: COMPLETED

## Цель

Довести avatar subsystem до следующего проверяемого продуктового шага после Phase 3: self-avatar и remote avatars должны реагировать ртом на реально слышимый аудиосигнал, а speaking feedback должен быть визуально понятным и стабильным в desktop и WebXR сценариях.

## Не-цель

- Не делать speech-to-phoneme, viseme network sync, cloud viseme service или face tracking.
- Не отправлять по сети дополнительные facial weights или другой lipsync payload.
- Не превращать фазу в full facial animation system с эмоциями, мимикой и сложным character polish.
- Не менять transport contract Phase 2, если для lipsync достаточно локального анализа уже существующего audio path.
- Не расширять фазу до seating, customization UI, нового avatar pack или нового backend-хранилища.

## Предпосылки и ограничения

- Roadmap уже фиксирует `Phase 4` как `Lipsync, speaking feedback и expressive polish` в `docs/2026-04-01-noah-avatar-system-tz-roadmap.md`.
- Базовый multiplayer avatar path уже есть: local snapshot/controller, remote pose sync, reliable state, reconnect/late join path и remote audio subscription.
- Remote audio уже подключается на стороне клиента через `connectRemoteAudioElement(...)` в `apps/runtime-web/src/main.ts`, а spatial audio path уже строится поверх `AudioContext` и `MediaElementSource`.
- В avatar catalog уже есть validation для `morphTargets`; это даёт точку входа для проверки наличия `mouth-open`/`viseme`-совместимых morphs без ввода нового asset format.
- Для этой фазы desktop и WebXR обязательны, mobile допускается только как safe fallback без отдельного acceptance как primary target.
- Пользователь явно не требует отдельной rollout-работы; значит план не должен разрастаться из-за новой флажковой инфраструктуры. Если существующий `avatarLipsyncEnabled` уже есть, его можно использовать как wiring detail, но не как отдельную фазовую цель.
- Проверка завершения должна включать локальные `unit/integration/e2e` и staging verification, а не только ручную проверку.

## Подход

Сделать lipsync локальным аудио-анализом на receiving side и на local mic side. Self-avatar двигает рот от собственного микрофонного сигнала, remote avatar двигает рот только от того аудио, которое реально проходит через клиентский audio graph. Это сохраняет простой transport contract, убирает потребность в viseme network payload и естественно переживает `mute`, late join и reconnect. Self lipsync должен браться из уже существующего local voice/live audio path, а не из отдельного параллельного media flow. В `v1` facial polish остаётся минимальным и дешёвым: mouth envelope, silence gate и speaking indicator. `blink/subtle idle facial motion` не является обязательным результатом фазы и допускается только как необязательный polish, если не расширяет asset/runtime contract.

## Definition of Done

Фаза завершена, если:

1. Self-avatar открывает рот от локального микрофонного сигнала и возвращается в neutral при `mute` или отсутствии track.
2. Remote avatar открывает рот только от реально слышимого на клиенте remote audio path, без нового сетевого facial payload.
3. Для пресетов без lipsync morph targets runtime использует безопасный visual fallback и не ломает avatar path.
4. Late join, reconnect и `TrackUnsubscribed` не оставляют stuck speaking state и не создают утечек audio/analyser nodes.
5. Локальные `pnpm build`, `pnpm test`, `pnpm test:e2e` и staging `pnpm test:e2e:staging` зелёные.

## Итог

Фаза завершена как `v1` main-path delivery. Реализованы self/remote lipsync без нового facial network payload, audible remote playback, desktop/VR self-visibility fixes, VR root/body alignment, room HUD audio controls (`Microphone`, `Speaker`, `Mic level`, `Speaker level`) и staging-facing e2e/smoke verification. Сложный face system, viseme/phoneme mapping и расширенный expressive polish сознательно оставлены вне scope этой фазы.

## Задачи (чек-лист)

### 1. Зафиксировать lipsync contract фазы

- [x] Подтвердить минимальный runtime contract `audio level -> smoothed mouth amount -> avatar morph/visual state` без сетевого facial payload.
- [x] Подтвердить, какие morph targets считаются обязательными для lipsync `v1` и что при их отсутствии runtime деградирует в `speaking indicator only`.
- [x] Явно отделить обязательный результат фазы (`mouth reaction + speaking indicator`) от необязательного polish (`blink/subtle idle facial motion`).
- [x] Явно зафиксировать, что `AvatarReliableState` и `CompactPoseFrame` в этой фазе не расширяются.

### 2. Собрать общий lipsync runtime module

- [x] Добавить модуль `apps/runtime-web/src/avatar/avatar-lipsync.ts` с чистыми функциями/состоянием для envelope smoothing, silence gate, attack/release и amplitude-to-mouth mapping.
- [x] Сделать модуль пригодным и для self, и для remote path, чтобы не дублировать логику в `main.ts`.
- [x] Зафиксировать bounded cost: обновление lipsync должно быть дёшево по CPU и безопасно при отсутствии аудио-кадров.

### 3. Подключить self-avatar lipsync

- [x] Найти локальный mic audio path после `joinAudio()` и подключить к нему `AnalyserNode` или эквивалентный analyser path без ломания текущего voice flow.
- [x] Брать self lipsync сигнал из уже существующего local voice/live audio path, а не из нового параллельного media source.
- [x] Преобразовать локальный audio level в mouth amount через общий lipsync driver.
- [x] При `mute`, отсутствии микрофона или остановке track рот self-avatar должен возвращаться в neutral без залипания.
- [x] Не делать self lipsync источником сетевых данных; remote участники должны продолжать жить только от своего receiving-side audio path.

### 4. Подключить remote-avatar lipsync

- [x] Расширить путь `connectRemoteAudioElement(...)` / `disconnectRemoteAudioElement(...)`, чтобы на каждого remote participant создавался и корректно очищался analyser path вместе с текущим spatial audio graph.
- [x] Привязать remote mouth amount к `participantId` и существующему lifecycle remote avatar model.
- [x] Гарантировать, что late join и reconnect повторно поднимают analyser без дублей и утечек Web Audio nodes.
- [x] При отсутствии remote audio element или при `TrackUnsubscribed` рот remote avatar возвращается в neutral.

### 5. Довести avatar visual application до Phase 4 scope

- [x] Расширить `apps/runtime-web/src/avatar/avatar-instance.ts` или соседний visual helper, чтобы инстанс умел принимать mouth/speaking state.
- [x] Сделать безопасный fallback для procedural/debug avatars и для пресетов без нужных morph targets; минимальный fallback контракт - `speaking indicator only`.
- [x] Добавить speaking indicator как отдельное дешёвое визуальное состояние, чтобы фаза оставалась полезной даже на упрощённых avatar visuals.
- [ ] Добавить blink/subtle idle facial motion только если это не требует нового asset contract и не ломает основной scope.

### 6. Интегрировать lipsync в local/remote avatar orchestration

- [x] Подключить self lipsync update в local avatar update path без разрастания `apps/runtime-web/src/main.ts` в новый монолит.
- [x] Подключить remote lipsync update в `remote-avatar-runtime` или близкий orchestration слой по `participantId`.
- [x] Обновлять debug/diagnostics так, чтобы было видно наличие analyser path, `mouthAmount`, `speakingActive`, `lipsyncSourceState` и причины fallback.

### 7. Закрыть крайние случаи и деградацию

- [x] Проверить `mute/unmute` для self без застрявшего mouth-open state.
- [x] Проверить отсутствие audio track: lipsync path не падает и не создаёт noisy false positives.
- [x] Проверить late join: новый клиент видит remote speaking feedback после подключения audio.
- [x] Проверить reconnect: старые analyser/resources очищаются, новый path поднимается корректно.
- [x] Проверить двух говорящих одновременно: состояние не путается между `participantId`, и cost не ломает room flow.

### 8. Довести фазу до staging-ready состояния

- [x] Обновить roadmap/phase docs по фактическому Phase 4 contract и границам `v1`.
- [x] Прогнать локально обязательный набор: `pnpm build`, `pnpm test`, `pnpm test:e2e`.
- [x] После внедрения выкатить изменения на staging обычным git-based flow и прогнать `pnpm test:e2e:staging`.
- [x] На staging подтвердить, что lipsync path не ломает room load, audio join, remote sync и WebXR entry.

## Затронутые файлы/модули (если известно)

- `docs/2026-04-01-noah-avatar-system-tz-roadmap.md`
- `docs/plans/2026-04-08-phase-4-avatar-lipsync-speaking-feedback-v1.md`
- `apps/runtime-web/src/main.ts`
- `apps/runtime-web/src/voice.ts`
- `apps/runtime-web/src/spatial-audio.ts`
- `apps/runtime-web/src/avatar/avatar-lipsync.ts` (новый)
- `apps/runtime-web/src/avatar/avatar-instance.ts`
- `apps/runtime-web/src/avatar/avatar-session.ts`
- `apps/runtime-web/src/avatar/avatar-controller.ts`
- `apps/runtime-web/src/avatar/remote-avatar-runtime.ts`
- `apps/runtime-web/src/avatar/avatar-debug.ts`
- `apps/runtime-web/src/avatar/avatar-types.ts` (если потребуется явный visual/lipsync contract)
- `apps/runtime-web/src/avatar/*.test.ts`
- `tests/e2e/runtime.spec.ts`
- `tests/e2e/runtime-staging.spec.ts`

## Тест-план

### Unit

- [x] `envelope smoothing`: резкий вход/выход сигнала даёт ожидаемый attack/release без дрожания.
- [x] `silence gate`: шум ниже порога не открывает рот.
- [x] `amplitude -> mouth amount`: маппинг ограничен в `0..1`, без overshoot.
- [x] `mute/no-track fallback`: driver возвращает neutral state.
- [ ] `blink/idle` logic, если она будет включена в scope `v1`.

### Integration

- [ ] Synthetic local audio source двигает рот self-avatar без реального микрофона в тестовом harness.
- [ ] Synthetic remote audio element двигает рот только у нужного `participantId`.
- [x] `TrackSubscribed`/`TrackUnsubscribed` корректно создают и очищают analyser path.
- [x] Late join после уже активного remote speaker поднимает speaking feedback без ручного reset.
- [x] Reconnect не оставляет duplicate analyser nodes и duplicate speaking state.
- [x] Два одновременных speaker path не смешивают mouth state между участниками.

### E2E

- [x] Расширить локальный e2e-сценарий так, чтобы он покрывал audio join и минимум один проверяемый speaking/lipsync signal path.
- [x] Зафиксировать стабильный debug signal для e2e: `mouthAmount`, `speakingActive`, `lipsyncSourceState` по self и remote participant.
- [x] Прогнать локально `pnpm build`.
- [x] Прогнать локально `pnpm test`.
- [x] Прогнать локально `pnpm test:e2e`.
- [x] После выкладки прогнать `pnpm test:e2e:staging`.

### Manual

- [x] Desktop self: говорить в микрофон, проверить mouth reaction и neutral return после `mute`.
- [x] Desktop <-> desktop: два клиента говорят по очереди и одновременно; remote mouth коррелирует со слышимым звуком.
- [x] Desktop <-> WebXR: remote avatar speaking feedback и lipsync не ломают XR flow и не создают заметный jitter.
- [x] Late join и reconnect в комнате с уже активным аудио.

### Негативные кейсы

- [x] Микрофон не выдан или выключен: self lipsync не падает и остаётся в neutral.
- [x] Remote audio track отсутствует: avatar остаётся без рта/индикатора, но остальная avatar pipeline жива.
- [x] Remote track быстро subscribe/unsubscribe: не возникает утечек analyser nodes и stuck speaking state.
- [x] Одновременная речь двух участников: состояние не перепутывается между remote avatars.
- [x] High room load / heavy scene: lipsync path не ломает room load и не даёт заметной деградации основного avatar sync.

## Риски и откаты (roll-back)

- Риск: Phase 4 расползётся в полный facial animation system.
  - Откат: оставить в обязательном scope только mouth envelope и speaking indicator; blink/idle считать вторичным polish.
- Риск: lipsync логика снова разрастётся в `apps/runtime-web/src/main.ts`.
  - Откат: держать analyser/driver/application в `apps/runtime-web/src/avatar/*`, а `main.ts` оставить wiring-слоем.
- Риск: remote lipsync будет зависеть от сети, а не от реально слышимого аудио.
  - Откат: анализировать только local mic path для self и receiving-side audio element path для remote.
- Риск: late join/reconnect оставят висячие `MediaElementSource`/`AnalyserNode`.
  - Откат: централизовать create/dispose analyser lifecycle рядом с `connectRemoteAudioElement(...)` и `disconnectRemoteAudioElement(...)`.
- Риск: некоторые avatar presets не имеют нужных morph targets.
  - Откат: speaking indicator и neutral-safe fallback должны сохранять рабочий avatar path без падения runtime.
- Риск: lipsync добавит заметный CPU overhead в комнатах с несколькими говорящими.
  - Откат: ограничить частоту анализа, не делать тяжёлый per-frame face solve и при необходимости деградировать до speaking indicator без сложного morph application.
